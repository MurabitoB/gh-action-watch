import { test, expect, mock } from 'claude-code/testing'

const WORKFLOW = `name: CI
on:
  workflow_dispatch:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: make
  test:
    needs: [build]
    strategy:
      matrix:
        node: [18, 20]
    steps:
      - run: make test
  deploy:
    needs:
      - test
    steps:
      - run: make deploy
`

const step = (name: string, status: string, conclusion: string | null) => ({
  name,
  status,
  conclusion,
  startedAt: '2026-01-01T00:00:00Z',
  completedAt: status === 'completed' ? '2026-01-01T00:00:05Z' : '0001-01-01T00:00:00Z',
})
const job = (name: string, status: string, conclusion: string | null) => ({
  name,
  status,
  conclusion,
  startedAt: '2026-01-01T00:00:00Z',
  completedAt: status === 'completed' ? '2026-01-01T00:00:09Z' : '0001-01-01T00:00:00Z',
  steps: [step('Set up job', 'completed', 'success'), step('Run it', status, conclusion)],
})

// The fake `gh`: what `gh run view` reports, and what a failed run's log says.
function fakeGh(view: () => object, log = '') {
  return (argv: readonly string[]) => {
    const a = argv.join(' ')
    const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' })
    if (a.startsWith('gh run list') && a.includes('--limit 1')) return ok('[{"databaseId":100}]')
    if (a.startsWith('gh run list') && a.includes('--commit')) return ok('[{"databaseId":300}]')
    if (a.startsWith('gh run list')) return ok('[{"databaseId":101,"createdAt":"2026-01-01T00:00:00Z"}]')
    if (a.startsWith('gh run view') && a.includes('--log-failed')) return ok(log)
    if (a.startsWith('gh run view')) return ok(JSON.stringify(view()))
    if (a.startsWith('gh repo view')) return ok('{"nameWithOwner":"o/r","url":"https://ghe.example.com/o/r"}')
    if (a.includes('--jq')) return ok('.github/workflows/ci.yml|abc123')
    if (a.startsWith('gh api')) return ok(WORKFLOW)
    if (a.startsWith('gh pr view')) return ok('{"headRefOid":"abc123","number":1}')
    if (a.startsWith('git rev-parse')) return ok('abc123\n')
    return { exitCode: 1, stdout: '', stderr: `unexpected: ${a}` }
  }
}

// The engine beneath the plugin: `gh` and `git` are the fake, state and the UI stay in memory.
function wire(on: any, gh: (argv: readonly string[]) => any, toolText = '') {
  const toasts: string[] = []
  const argvs: string[] = []
  const state: Record<string, any> = {}
  let version = 0
  on('process.run', (_: any, e: any) => {
    argvs.push(e.argv.join(' '))
    return { value: gh(e.argv) }
  })
  on('state.get', (_: any, e: any) => ({ value: { value: state[e.key], version } }))
  on('state.set', (_: any, e: any) => {
    state[e.key] = e.value
    return { value: { isSet: true, version: ++version } }
  })
  on('tool.call', () => ({ result: { stdout: '', stderr: '' }, text: toolText }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('session.append', (_: any, e: any) => {
    return { value: { message: e.message, uuid: 'u1' } }
  })
  return { toasts, argvs, state }
}

test('gh workflow run: finds the run, builds the graph, reports once it finishes', async ($, on) => {
  const clock = mock.clock(on)
  let phase = 'running'
  const seen = wire(
    on,
    fakeGh(() => ({
      databaseId: 101,
      workflowName: 'CI',
      displayTitle: 'CI',
      status: phase === 'running' ? 'in_progress' : 'completed',
      conclusion: phase === 'running' ? '' : 'success',
      url: 'https://ghe.example.com/o/r/actions/runs/101',
      startedAt: '2026-01-01T00:00:00Z',
      attempt: 1,
      jobs:
        phase === 'running'
          ? [job('build', 'in_progress', null)]
          : [
              job('build', 'completed', 'success'),
              job('test (18)', 'completed', 'success'),
              job('test (20)', 'completed', 'success'),
              job('deploy', 'completed', 'success'),
            ],
    })),
  )

  await $.tool.call({ tool: 'Bash', command: 'gh workflow run ci.yml' })
  await clock.advance(3000)

  const midway = seen.state.watch
  expect(midway.runs).toHaveLength(1)
  expect(midway.runs[0].nodes.map(n => [n.id, n.level, n.status])).toEqual([
    ['build', 0, 'in_progress'],
    ['test', 1, 'pending'],
    ['deploy', 2, 'pending'],
  ])
  expect(midway.runs[0].nodes[1].needs).toEqual(['build'])
  expect(seen.toasts).toHaveLength(0)
  // the workflow file is read from the run's own host, not the default one
  expect(seen.argvs.some(a => a.includes('--hostname ghe.example.com'))).toBe(true)

  phase = 'done'
  await clock.advance(3000)

  const done = seen.state.watch
  const test = done.runs[0].nodes.find(n => n.id === 'test')!
  expect(test.isMatrix).toBe(true)
  expect(test.instances).toHaveLength(2)
  expect(done.runs[0].nodes.every(n => n.conclusion === 'success')).toBe(true)
  expect(seen.toasts).toEqual(['CI: success'])

  // polling stopped: no further reports however long it runs
  await clock.advance(30000)
  expect(seen.toasts).toHaveLength(1)
})

test('a failed run reports the cleaned tail of its failing step', async ($, on) => {
  const clock = mock.clock(on)
  const log = [
    'deploy\tSmoke test\t﻿2026-01-01T00:00:00.1Z ##[group]Run make',
    'deploy\tSmoke test\t2026-01-01T00:00:01Z \u001b[36;1mmake deploy\u001b[0m',
    'deploy\tSmoke test\t2026-01-01T00:00:02Z ##[endgroup]',
    'deploy\tSmoke test\t2026-01-01T00:00:03Z boom',
    'deploy\tSmoke test\t2026-01-01T00:00:04Z ##[error]Process completed with exit code 1.',
  ].join('\n')
  const seen = wire(
    on,
    fakeGh(
      () => ({
        databaseId: 101,
        workflowName: 'CI',
        displayTitle: 'CI',
        status: 'completed',
        conclusion: 'failure',
        url: 'u',
        startedAt: '2026-01-01T00:00:00Z',
        attempt: 1,
        jobs: [job('deploy', 'completed', 'failure')],
      }),
      log,
    ),
  )

  await $.tool.call({ tool: 'Bash', command: 'gh workflow run ci.yml' })
  await clock.advance(3000)

  const run = seen.state.watch.runs[0]
  expect(run.failures).toEqual([
    { job: 'deploy', step: 'Smoke test', lines: ['make deploy', 'boom', 'error: Process completed with exit code 1.'] },
  ])
  expect(seen.toasts).toEqual(['CI: failure'])
})

test('gh pr create follows every run of the PR head commit', async ($, on) => {
  const clock = mock.clock(on)
  const seen = wire(
    on,
    fakeGh(() => ({
      databaseId: 300,
      workflowName: 'Lint',
      displayTitle: 'Lint',
      status: 'in_progress',
      conclusion: '',
      url: 'u',
      startedAt: '2026-01-01T00:00:00Z',
      attempt: 1,
      jobs: [job('lint', 'in_progress', null)],
    })),
    'https://ghe.example.com/o/r/pull/1',
  )

  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
  await clock.advance(3000)

  const runs = seen.state.watch.runs
  expect(runs.map(r => r.id)).toEqual([300])
})

test('an unrelated Bash command starts nothing', async ($, on) => {
  const clock = mock.clock(on)
  const seen = wire(on, fakeGh(() => ({})))

  await $.tool.call({ tool: 'Bash', command: 'ls -la' })
  await clock.advance(10000)

  expect(seen.argvs).toEqual([])
})

const runView = (id: number, name: string) => () => ({
  databaseId: id,
  workflowName: name,
  displayTitle: name,
  status: 'in_progress',
  conclusion: '',
  url: 'u',
  startedAt: '2026-01-01T00:00:00Z',
  attempt: 1,
  jobs: [job('lint', 'in_progress', null)],
})

test('git push follows the runs of the new HEAD commit', async ($, on) => {
  const clock = mock.clock(on)
  const seen = wire(on, fakeGh(runView(300, 'Lint')))

  await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  await clock.advance(3000)

  expect(seen.argvs).toContain('git rev-parse HEAD')
  expect(seen.state.watch.runs.map((r: any) => r.id)).toEqual([300])
})

test('git push in a repo with no Actions stays silent', async ($, on) => {
  const clock = mock.clock(on)
  const seen = wire(on, () => ({ exitCode: 1, stdout: '', stderr: 'not a github repo' }))

  await $.tool.call({ tool: 'Bash', command: 'git push' })
  await clock.advance(10000)

  expect(seen.state.watch).toBeUndefined()
})

test('gh run rerun follows the named run', async ($, on) => {
  const clock = mock.clock(on)
  const seen = wire(on, fakeGh(runView(101, 'CI')))

  await $.tool.call({ tool: 'Bash', command: 'gh run rerun 101 --failed' })
  await clock.advance(3000)

  expect(seen.state.watch.runs.map((r: any) => r.id)).toEqual([101])
})
