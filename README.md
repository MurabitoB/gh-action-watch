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

Prerequisites: the [`gh` CLI](https://cli.github.com), logged in (`gh auth login`), and a Claude Code session started inside the repository you run workflows in.

### From the marketplace (no clone)

```sh
claude plugin marketplace add MurabitoB/gh-action-watch
claude plugin install gh-action-watch@gh-action-watch
```

Start a new session, then type `/gh-actions`. If the pane opens, it is installed.

### From a local copy

```sh
git clone https://github.com/MurabitoB/gh-action-watch
claude --plugin-dir ./gh-action-watch
```

For GitHub Enterprise Server, log in with `gh auth login --hostname <host>`; the workflow file is read through that repo's own host. This has not been tried against a real GHES.

### Troubleshooting

- The pane does not open by itself: a pane opened by a trigger needs a terminal at least 144 columns wide. `/gh-actions` opens it at any width.
- `gh error: ...` in the pane: `gh` is not logged in, or the session is not inside the repository.
- Nothing happens after a command: only commands run through Claude's Bash tool are noticed, not the `!` shell prefix or another terminal.

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

## License

MIT, see [LICENSE](LICENSE).
