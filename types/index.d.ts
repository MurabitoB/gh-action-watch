export type Step = { name: string; status: string; conclusion: string | null }
export type Job = { name: string; status: string; conclusion: string | null; steps: Step[] }
export type Run = {
  id: number
  name: string
  status: string
  conclusion: string | null
  url: string
  jobs: Job[]
}
export type Watch = { run: Run | null; note: string }

declare module 'claude-code' {
  interface PluginState {
    'gh-action-watch': { watch: Watch }
  }
}
