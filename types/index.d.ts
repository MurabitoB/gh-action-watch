export type Step = { name: string; status: string; conclusion: string | null }
export type Job = { name: string; status: string; conclusion: string | null; steps: Step[] }
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
}
export type Watch = { run: Run | null; note: string }

declare module 'claude-code' {
  interface PluginState {
    'gh-action-watch': { watch: Watch }
  }
}
