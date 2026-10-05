# gh-action-watch

A Claude Code mod: a side pane that live-renders GitHub Actions runs as you start them from the session.

## What it does

| You run (through the Bash tool) | The pane follows |
| --- | --- |
| `gh workflow run ...` | the run you just dispatched |
| `gh pr create ...` | every workflow run of the PR's head commit |
| `git push` | the runs of the new HEAD commit (stays silent if there are none) |
| `gh run rerun <id>` | that run |
| `/gh-actions <run-id>` | any existing run |

For each run the pane shows:

- the job **dependency graph**, in stages, with each job's `needs`; jobs that have not started yet show as waiting
- **matrix** jobs expanded into their instances (finished instances collapse to one line)
- jobs and steps with status glyphs (green ✓, red ✗, yellow ●, gray ⊘, dim ○) and **elapsed time**
- the **tail of the failing step's log** when a run fails
- **tabs** (`All` / one per run) when several runs are followed, and **↻ Rerun failed / ↻ Rerun all** buttons on finished runs

When a run finishes, a toast is shown and a short summary (conclusion, failed jobs, failing log tail) is added to the conversation, so you can ask Claude to fix it. It is only added; it does not start a turn.

`/gh-actions` opens the pane by hand. A pane opened by a trigger needs a terminal at least 144 columns wide.

## Install

```sh
claude --plugin-dir /path/to/gh-action-watch
```

Requires the `gh` CLI, logged in, with the session started inside the repository. For GitHub Enterprise Server, log in with `gh auth login --hostname <host>`; the workflow file is read through that repo's own host. This has not been tried against a real GHES.

## Limits

- Only GitHub Actions runs; other CI providers' checks do not appear.
- A job whose `name:` uses `${{ }}` is shown under its job id.
- Runs started outside the Bash tool (another terminal, the `!` shell prefix) are not noticed; use `/gh-actions <run-id>`.

## Develop

```sh
claude plugin validate .
claude plugin test .
```

`.github/workflows/sample.yml` and `lint.yml` are sample workflows (branching jobs, a matrix, an optional failure via `-f fail=true`) for trying the pane.
