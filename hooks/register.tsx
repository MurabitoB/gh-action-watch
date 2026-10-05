import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Run, Watch } from '../types'

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

async function fetchRun($: any, id: number): Promise<Run> {
  const r = await gh($, ['run', 'view', String(id), '--json', 'databaseId,workflowName,displayTitle,status,conclusion,url,jobs'])
  return {
    id: r.databaseId,
    name: r.workflowName || r.displayTitle,
    status: r.status,
    conclusion: r.conclusion || null,
    url: r.url,
    jobs: (r.jobs ?? []).map((j: any) => ({
      name: j.name,
      status: j.status,
      conclusion: j.conclusion || null,
      steps: (j.steps ?? []).map((s: any) => ({
        name: s.name,
        status: s.status,
        conclusion: s.conclusion || null,
      })),
    })),
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

    return (
      <Box flexDirection="column">
        {run && (
          <Text bold>
            {icon(run.status, run.conclusion)} {run.name} #{run.id} ({run.conclusion ?? run.status})
          </Text>
        )}
        {run && <Text dimColor>{run.url}</Text>}
        {note !== '' && <Text dimColor>{note}</Text>}
        {run?.jobs.map(job => (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>
              {icon(job.status, job.conclusion)} {job.name}
            </Text>
            {job.steps.map(step => (
              <Text dimColor={step.status === 'completed' || step.status === 'queued'}>
                {'  '}
                {icon(step.status, step.conclusion)} {step.name}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}
