export type Step = {
  name: string
  status: string
  conclusion: string | null
  startedAt: number | null
  completedAt: number | null
}
export type Job = {
  name: string
  status: string
  conclusion: string | null
  startedAt: number | null
  completedAt: number | null
  steps: Step[]
}
export type Failure = { job: string; step: string; lines: string[] }
export type Node = {
  id: string
  label: string
  needs: string[]
  level: number
  isMatrix: boolean
  status: string
  conclusion: string | null
  instances: Job[]
}
export type Run = {
  id: number
  name: string
  status: string
  conclusion: string | null
  url: string
  nodes: Node[]
  startedAt: number | null
  failures: Failure[]
}
export type Watch = { runs: Run[]; note: string }

declare module 'claude-code' {
  interface PluginState {
    'gh-action-watch': { watch: Watch }
  }
}
