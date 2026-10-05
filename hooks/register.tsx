import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Failure, Job, Node, Run, Watch } from '../types'

const PANE = 'gh-actions'
const POLL_MS = 3000
const FIND_TRIES = 20
const LOG_TAIL = 20
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

const ms = (iso: string | null | undefined) => {
  const v = iso ? Date.parse(iso) : NaN
  return Number.isNaN(v) || v <= 0 ? null : v
}

function fmtDur(total: number) {
  const sec = Math.max(0, Math.round(total / 1000))
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const rest = String(sec % 60).padStart(2, '0')
  return m < 60 ? `${m}m${rest}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

// Elapsed (running) or total (done); empty before it starts.
function dur(startedAt: number | null, completedAt: number | null, now: number) {
  if (startedAt === null) return ''
  return ` ${fmtDur((completedAt ?? now) - startedAt)}`
}

// `gh run view --log-failed` prints `job<TAB>step<TAB>timestamp line`; keep each step's tail.
function parseFailedLog(text: string): Failure[] {
  const out: Failure[] = []
  for (const raw of text.split('\n')) {
    const parts = raw.replace(/^﻿/, '').split('\t')
    if (parts.length < 3) continue
    const line = parts.slice(2).join('\t').replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, '')
    let f = out.find(x => x.job === parts[0] && x.step === parts[1])
    if (!f) {
      f = { job: parts[0], step: parts[1], lines: [] }
      out.push(f)
    }
    f.lines.push(line)
  }
  return out.map(f => ({ ...f, lines: f.lines.slice(-LOG_TAIL) }))
}

function summarize(run: Run): string {
  const lines = [`[gh-action-watch] Workflow "${run.name}" run #${run.id} finished: ${run.conclusion}. ${run.url}`]
  for (const n of run.nodes) {
    const bad = n.instances.filter(j => j.status === 'completed' && j.conclusion !== 'success' && j.conclusion !== 'skipped')
    for (const j of bad) {
      const step = j.steps.find(s => s.conclusion === 'failure')
      lines.push(`- job "${j.name}" ${j.conclusion}${step ? ` at step "${step.name}"` : ''}`)
    }
  }
  for (const f of run.failures) {
    lines.push('', `Failed log tail, ${f.job} / ${f.step}:`, ...f.lines.slice(-LOG_TAIL))
  }
  return lines.join('\n').slice(0, 8000)
}

// A finished run's end: the last job to complete.
function lastEnd(run: Run): number | null {
  const ends = run.nodes.flatMap(n => n.instances.map(j => j.completedAt)).filter((x): x is number => x !== null)
  return ends.length > 0 ? Math.max(...ends) : null
}

let cachedRepo: { host: string; slug: string } | undefined | null
let cachedFailures: { runId: number; failures: Failure[] } | undefined
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

// The repo's host and slug, so `gh api` reaches a GitHub Enterprise Server too.
async function repoInfo($: any): Promise<{ host: string; slug: string } | null> {
  if (cachedRepo !== undefined) return cachedRepo
  try {
    const r = JSON.parse(await ghText($, ['repo', 'view', '--json', 'nameWithOwner,url']))
    const host = /^https?:\/\/([^/]+)\//.exec(r.url)?.[1]
    cachedRepo = host ? { host, slug: r.nameWithOwner } : null
  } catch {
    cachedRepo = null
  }
  return cachedRepo
}

// Newest dispatched run's id before a trigger: the new run is the first with a larger id.
async function latestRunId($: any): Promise<number> {
  try {
    const list = await gh($, ['run', 'list', '--event', 'workflow_dispatch', '--limit', '1', '--json', 'databaseId'])
    return list[0]?.databaseId ?? 0
  } catch {
    return -1
  }
}

// The API does not expose `needs`, so read the workflow file at the run's commit (once per run).
async function loadDefs($: any, id: number): Promise<Def[]> {
  if (cachedDefs?.runId === id) return cachedDefs.defs
  let defs: Def[] = []
  try {
    const repo = await repoInfo($)
    const base = repo ? ['api', '--hostname', repo.host] : ['api']
    const slug = repo ? repo.slug : '{owner}/{repo}'
    const meta = (await ghText($, [...base, `repos/${slug}/actions/runs/${id}`, '--jq', '.path + "|" + .head_sha'])).trim()
    const [path, sha] = meta.split('|')
    const text = await ghText($, [...base, '-H', 'Accept: application/vnd.github.raw', `repos/${slug}/contents/${path.split('@')[0]}?ref=${sha}`])
    defs = parseWorkflow(text)
  } catch {
    defs = []
  }
  cachedDefs = { runId: id, defs }
  return defs
}

// Failed steps' log tails, fetched once when the run has finished unsuccessfully.
async function loadFailures($: any, id: number): Promise<Failure[]> {
  if (cachedFailures?.runId === id) return cachedFailures.failures
  let failures: Failure[] = []
  try {
    failures = parseFailedLog(await ghText($, ['run', 'view', String(id), '--log-failed']))
  } catch {
    failures = []
  }
  cachedFailures = { runId: id, failures }
  return failures
}

async function fetchRun($: any, id: number): Promise<Run> {
  const r = await gh($, ['run', 'view', String(id), '--json', 'databaseId,workflowName,displayTitle,status,conclusion,url,startedAt,jobs'])
  const defs = await loadDefs($, id)
  const jobs: Job[] = (r.jobs ?? []).map((j: any) => ({
    name: j.name,
    status: j.status,
    conclusion: j.conclusion || null,
    startedAt: ms(j.startedAt),
    completedAt: ms(j.completedAt),
    steps: (j.steps ?? [])
      .filter((s: any) => s.name !== 'Set up job' && s.name !== 'Complete job')
      .map((s: any) => ({
        name: s.name,
        status: s.status,
        conclusion: s.conclusion || null,
        startedAt: ms(s.startedAt),
        completedAt: ms(s.completedAt),
      })),
  }))
  const isBad = r.status === 'completed' && r.conclusion !== 'success' && r.conclusion !== 'skipped'
  return {
    id: r.databaseId,
    name: r.workflowName || r.displayTitle,
    status: r.status,
    conclusion: r.conclusion || null,
    url: r.url,
    startedAt: ms(r.startedAt),
    nodes: buildNodes(defs, jobs),
    failures: isBad ? await loadFailures($, id) : [],
  }
}

// Follow one run until it completes. `runId` null: locate the run triggered after `baseline`
// (the newest run id before the trigger; -1 when unknown, then `since` decides).
function follow($: any, runId: number | null, since: number, baseline: number) {
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
        const hit = list.find((r: any) => (baseline >= 0 ? r.databaseId > baseline : Date.parse(r.createdAt) >= since - 10000))
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
        await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: summarize(run) }] } })
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
      follow($, id, 0, -1)
    }
    return { text: 'GitHub Actions pane opened.' }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const isTrigger = TRIGGER.test(e.command)
    const since = await $.clock.now()
    const baseline = isTrigger ? await latestRunId($) : -1
    const ran = await next(e)
    if (isTrigger && ran.deny === undefined && !ran.isError) {
      await $.ui.open({ id: PANE, title: 'GitHub Actions' })
      await update($, watch, () => ({ run: null, note: 'Waiting for the run to appear…' }))
      follow($, null, since, baseline)
    }
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const { run, note } = await read($, watch)
    const now = await $.clock.now()
    const levels: Node[][] = []
    for (const n of run?.nodes ?? []) (levels[n.level] ??= []).push(n)
    const stages = levels.filter(Boolean)

    return (
      <Box flexDirection="column">
        {run && (
          <Text bold>
            {icon(run.status, run.conclusion)} {run.name} #{run.id} ({run.conclusion ?? run.status}){dur(run.startedAt, run.status === 'completed' ? lastEnd(run) : null, now)}
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
                  {n.instances.length === 1 ? dur(n.instances[0].startedAt, n.instances[0].completedAt, now) : ''}
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
                          {icon(job.status, job.conclusion)} {job.name}{dur(job.startedAt, job.completedAt, now)}
                        </Text>
                      )}
                      {showSteps &&
                        job.steps.map(step => (
                          <Text dimColor={step.status === 'completed' || step.status === 'queued'}>
                            {n.isMatrix ? (last ? '       ' : '  │    ') : '  '}
                            {icon(step.status, step.conclusion)} {step.name}{dur(step.startedAt, step.completedAt, now)}
                          </Text>
                        ))}
                    </Box>
                  )
                })}
              </Box>
            ))}
          </Box>
        ))}
        {run && run.failures.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Failed logs</Text>
            {run.failures.map(f => (
              <Box flexDirection="column">
                <Text bold>
                  ✗ {f.job} / {f.step}
                </Text>
                {f.lines.map(l => (
                  <Text dimColor>  {l}</Text>
                ))}
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
