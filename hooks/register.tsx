import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Job, Node, Run, Watch } from '../types'

const PANE = 'gh-actions'
const POLL_MS = 3000
const FIND_TRIES = 20
const TRIGGER = /\bgh\s+workflow\s+run\b/

const watch = atom({ plugin: 'gh-action-watch', key: 'watch' } as const, {
  run: null,
  note: 'No run yet. Trigger one with `gh workflow run`, or /gh-actions <run-id>.',
} as Watch)

const icon = (status: string, conclusion: string | null) => {
  if (status === 'completed') {
    if (conclusion === 'success') return '✓'
    if (conclusion === 'skipped' || conclusion === 'cancelled') return '⊘'
    return '✗'
  }
  if (status === 'in_progress') return '●'
  return '○'
}


type Def = { id: string; label: string; needs: string[]; isMatrix: boolean }

const unquote = (v: string) => v.replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '')

// Minimal reader of a workflow's `jobs:` block: id, name, needs, strategy.
function parseWorkflow(text: string): Def[] {
  const lines = text.split('\n')
  const start = lines.findIndex(l => /^jobs:\s*(#.*)?$/.test(l))
  if (start < 0) return []
  const defs: Def[] = []
  let jobIndent = -1
  let childIndent = -1
  let cur: Def | undefined
  let inNeeds = false
  for (const raw of lines.slice(start + 1)) {
    if (/^\s*(#.*)?$/.test(raw)) continue
    const indent = raw.length - raw.trimStart().length
    if (indent === 0) break
    const t = raw.trim()
    if (jobIndent < 0) jobIndent = indent
    if (indent === jobIndent) {
      const m = /^([\w.-]+):/.exec(t)
      if (!m) continue
      cur = { id: m[1], label: m[1], needs: [], isMatrix: false }
      defs.push(cur)
      childIndent = -1
      inNeeds = false
      continue
    }
    if (!cur) continue
    if (childIndent < 0) childIndent = indent
    if (indent === childIndent) {
      inNeeds = false
      const m = /^([\w-]+):\s*(.*)$/.exec(t)
      if (!m) continue
      const [, key, val] = m
      if (key === 'name') cur.label = unquote(val) || cur.id
      else if (key === 'strategy') cur.isMatrix = true
      else if (key === 'needs') {
        if (val.startsWith('[')) {
          cur.needs = val.replace(/[[\]]/g, '').split(',').map(unquote).filter(Boolean)
        } else if (unquote(val)) {
          cur.needs = [unquote(val)]
        } else {
          inNeeds = true
        }
      }
    } else if (inNeeds && t.startsWith('-')) {
      cur.needs.push(unquote(t.slice(1)))
    }
  }
  return defs
}

// Longest-path depth: a job sits one stage after its deepest dependency.
function levelOf(id: string, defs: Def[], seen: string[] = []): number {
  const d = defs.find(x => x.id === id)
  if (!d || seen.includes(id)) return 0
  return d.needs.length === 0 ? 0 : 1 + Math.max(...d.needs.map(n => levelOf(n, defs, [...seen, id])))
}

// Static part of a job name (a matrix name like `test (${{ matrix.os }})` keeps `test (`).
const staticName = (label: string) => label.split('${{')[0].trim()

function matches(runtime: string, d: Def) {
  const base = staticName(d.label)
  if (base === '') return runtime === d.id || runtime.startsWith(d.id + ' (') || runtime.startsWith(d.id + ' /')
  return (
    runtime === base ||
    runtime.startsWith(base + ' (') ||
    runtime.startsWith(base + ' /') ||
    (base !== d.label && runtime.startsWith(base))
  )
}

function aggregate(instances: Job[]): { status: string; conclusion: string | null } {
  if (instances.length === 0) return { status: 'pending', conclusion: null }
  if (instances.some(j => j.status === 'in_progress')) return { status: 'in_progress', conclusion: null }
  if (instances.some(j => j.status !== 'completed')) {
    return { status: instances.some(j => j.status === 'completed') ? 'in_progress' : 'queued', conclusion: null }
  }
  const c = instances.map(j => j.conclusion)
  if (c.includes('failure') || c.includes('timed_out')) return { status: 'completed', conclusion: 'failure' }
  if (c.includes('cancelled')) return { status: 'completed', conclusion: 'cancelled' }
  if (c.every(x => x === 'skipped')) return { status: 'completed', conclusion: 'skipped' }
  return { status: 'completed', conclusion: 'success' }
}

function buildNodes(defs: Def[], jobs: Job[]): Node[] {
  if (defs.length === 0) {
    return jobs.map(j => ({
      id: j.name,
      label: j.name,
      needs: [],
      level: 0,
      isMatrix: false,
      status: j.status,
      conclusion: j.conclusion,
      instances: [j],
    }))
  }
  const claimed = new Set<Job>()
  const nodes: Node[] = defs.map(d => {
    // the longest static name claims first, so `build` does not swallow `build-docs (x)`
    const inst = jobs.filter(j => !claimed.has(j) && matches(j.name, d))
    inst.forEach(j => claimed.add(j))
    const a = aggregate(inst)
    return {
      id: d.id,
      label: staticName(d.label) === d.label ? d.label : d.id,
      needs: d.needs,
      level: levelOf(d.id, defs),
      isMatrix: d.isMatrix || inst.length > 1,
      status: a.status,
      conclusion: a.conclusion,
      instances: inst,
    }
  })
  const rest = jobs.filter(j => !claimed.has(j))
  for (const j of rest) {
    nodes.push({ id: j.name, label: j.name, needs: [], level: 0, isMatrix: false, status: j.status, conclusion: j.conclusion, instances: [j] })
  }
  return nodes
}

let cachedDefs: { runId: number; defs: Def[] } | undefined

let timer: { cancel: () => void } | undefined
let busy = false

function stop() {
  timer?.cancel()
  timer = undefined
}

async function gh($: any, argv: string[]) {
  const out = await $.process.run(['gh', ...argv])
  if (out.exitCode !== 0) throw new Error(out.stderr.trim() || `gh exit ${out.exitCode}`)
  return JSON.parse(out.stdout)
}

async function ghText($: any, argv: string[]): Promise<string> {
  const out = await $.process.run(['gh', ...argv])
  if (out.exitCode !== 0) throw new Error(out.stderr.trim() || `gh exit ${out.exitCode}`)
  return out.stdout
}

// The API does not expose `needs`, so read the workflow file at the run's commit (once per run).
async function loadDefs($: any, id: number): Promise<Def[]> {
  if (cachedDefs?.runId === id) return cachedDefs.defs
  let defs: Def[] = []
  try {
    const meta = (await ghText($, ['api', `repos/{owner}/{repo}/actions/runs/${id}`, '--jq', '.path + "|" + .head_sha'])).trim()
    const [path, sha] = meta.split('|')
    const text = await ghText($, ['api', '-H', 'Accept: application/vnd.github.raw', `repos/{owner}/{repo}/contents/${path.split('@')[0]}?ref=${sha}`])
    defs = parseWorkflow(text)
  } catch {
    defs = []
  }
  cachedDefs = { runId: id, defs }
  return defs
}

async function fetchRun($: any, id: number): Promise<Run> {
  const r = await gh($, ['run', 'view', String(id), '--json', 'databaseId,workflowName,displayTitle,status,conclusion,url,jobs'])
  const defs = await loadDefs($, id)
  const jobs: Job[] = (r.jobs ?? []).map((j: any) => ({
    name: j.name,
    status: j.status,
    conclusion: j.conclusion || null,
    steps: (j.steps ?? [])
      .filter((s: any) => s.name !== 'Set up job' && s.name !== 'Complete job')
      .map((s: any) => ({ name: s.name, status: s.status, conclusion: s.conclusion || null })),
  }))
  return {
    id: r.databaseId,
    name: r.workflowName || r.displayTitle,
    status: r.status,
    conclusion: r.conclusion || null,
    url: r.url,
    nodes: buildNodes(defs, jobs),
  }
}

// Follow one run until it completes. `runId` null: locate the run triggered at `since`.
function follow($: any, runId: number | null, since: number) {
  stop()
  let id = runId
  let tries = 0
  timer = $.clock.every(POLL_MS, async () => {
    if (busy) return
    busy = true
    try {
      if (id === null) {
        tries++
        const list = await gh($, ['run', 'list', '--event', 'workflow_dispatch', '--limit', '5', '--json', 'databaseId,createdAt'])
        const hit = list.find((r: any) => Date.parse(r.createdAt) >= since - 10000)
        if (hit) id = hit.databaseId
        else if (tries >= FIND_TRIES) {
          stop()
          await update($, watch, () => ({ run: null, note: 'Could not find the triggered run.' }))
        } else {
          await update($, watch, () => ({ run: null, note: 'Waiting for the run to appear…' }))
        }
        if (id === null) return
      }
      const run = await fetchRun($, id)
      await update($, watch, () => ({ run, note: '' }))
      if (run.status === 'completed') {
        stop()
        $.ui.toast(`${run.name}: ${run.conclusion}`)
        $.ui.status(undefined)
      } else {
        $.ui.status(`Actions: ${run.name} ${run.status}`)
      }
    } catch (err) {
      await update($, watch, w => ({ ...w, note: `gh error: ${(err as Error).message}` }))
    } finally {
      busy = false
    }
  })
}


export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'gh-actions',
      description: 'Open the GitHub Actions pane; optionally pass a run id to watch',
    })
    return next(e)
  })

  on('command.run', { command: 'gh-actions' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: 'GitHub Actions' })
    const id = Number(e.args.trim())
    if (id) {
      await update($, watch, () => ({ run: null, note: `Loading run ${id}…` }))
      follow($, id, 0)
    }
    return { text: 'GitHub Actions pane opened.' }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const since = await $.clock.now()
    const ran = await next(e)
    if (TRIGGER.test(e.command) && ran.deny === undefined && !ran.isError) {
      await $.ui.open({ id: PANE, title: 'GitHub Actions' })
      await update($, watch, () => ({ run: null, note: 'Waiting for the run to appear…' }))
      follow($, null, since)
    }
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const { run, note } = await read($, watch)
    const levels: Node[][] = []
    for (const n of run?.nodes ?? []) (levels[n.level] ??= []).push(n)
    const stages = levels.filter(Boolean)

    return (
      <Box flexDirection="column">
        {run && (
          <Text bold>
            {icon(run.status, run.conclusion)} {run.name} #{run.id} ({run.conclusion ?? run.status})
          </Text>
        )}
        {run && <Text dimColor>{run.url}</Text>}
        {note !== '' && <Text dimColor>{note}</Text>}
        {stages.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Graph</Text>
            {stages.map((stage, i) => (
              <Box flexDirection="column">
                {i > 0 && <Text dimColor>  │</Text>}
                {stage.map((n, k) => (
                  <Text>
                    {i > 0 ? (k === 0 ? '  ▼ ' : '  │ ') : '    '}
                    {icon(n.status, n.conclusion)} {n.id}
                    {n.isMatrix ? ` ⟨matrix ${n.instances.filter(j => j.status === 'completed').length}/${n.instances.length}⟩` : ''}
                    {n.needs.length > 0 ? `  ← ${n.needs.join(', ')}` : ''}
                  </Text>
                ))}
              </Box>
            ))}
          </Box>
        )}
        {stages.map((stage, i) => (
          <Box flexDirection="column" marginTop={1}>
            <Text bold dimColor>
              Stage {i + 1}{stage.length > 1 ? ' (parallel)' : ''}
            </Text>
            {stage.map(n => (
              <Box flexDirection="column">
                <Text bold>
                  {icon(n.status, n.conclusion)} {n.label}
                  {n.isMatrix ? ' ⟨matrix⟩' : ''}
                </Text>
                {n.instances.length === 0 && <Text dimColor>  waiting on {n.needs.join(', ') || 'trigger'}</Text>}
                {n.instances.map((job, k) => {
                  const last = k === n.instances.length - 1
                  const showSteps = !n.isMatrix || job.status !== 'completed'
                  return (
                    <Box flexDirection="column">
                      {n.isMatrix && (
                        <Text>
                          {last ? '  └─ ' : '  ├─ '}
                          {icon(job.status, job.conclusion)} {job.name}
                        </Text>
                      )}
                      {showSteps &&
                        job.steps.map(step => (
                          <Text dimColor={step.status === 'completed' || step.status === 'queued'}>
                            {n.isMatrix ? (last ? '       ' : '  │    ') : '  '}
                            {icon(step.status, step.conclusion)} {step.name}
                          </Text>
                        ))}
                    </Box>
                  )
                })}
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}
