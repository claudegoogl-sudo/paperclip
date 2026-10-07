# host-disk-janitor

Nightly retention for this host: backup dumps, run-logs, stale `~/work/*` and
`~/pla<N>*` worktrees, and `/tmp` agent scratch. Entry point:
`scripts/host-disk-janitor.mjs` (dry-run by default; `--apply` deletes).
Tests: `node --test scripts/host-disk-janitor.test.mjs` (sandbox only).

## What is never deleted (worktree category)

A `~/work/*` / `~/pla<N>*` directory is deletion-eligible only if it is not a
git repo (or a clean, pushed repo) AND its newest file is older than 30 days.
Even then it is kept when any of these hold:

| Guard | Source | Log line |
|---|---|---|
| Registered plugin install | `plugins.package_path` (embedded Postgres) | `excluded (registered package path root: ...)` |
| Live reference | `crontab -l` | `excluded (referenced by crontab): <dir>` |
| Live reference | `~/.config/systemd/user/*.service`, `*.timer` (`ExecStart*`, `WorkingDirectory`, `EnvironmentFile`; `%h` = `$HOME`) | `excluded (referenced by systemd <unit>): <dir>` |
| Live reference | non-archived `routines` (title + description) | `excluded (referenced by routine <id>): <dir>` |
| Live reference | non-terminated `agents.adapter_config` (every string value) | `excluded (referenced by agent <name>): <dir>` |
| Keep-list file | `~/.config/host-disk-janitor/keep.txt` | `excluded (referenced by keep-list ...): <dir>` |
| Keep marker | a `.janitor-keep` file inside the dir | `excluded (keep marker .janitor-keep): <dir>` |

"Referenced" means the referenced path is at, inside, or contains the dir.
References at or above a scan root (for example an agent `cwd` of `$HOME`)
are ignored, because they would shield everything.

**Fail closed:** if the plugin registry or ANY live-reference source cannot be
read, the worktree category deletes nothing that run and prints
`live references: LOOKUP FAILED` with the reason.

## Keeping something the scan cannot see

```bash
# one dir
touch ~/work/my-tool/.janitor-keep
# or a central list: one absolute path per line, '#' comments, '~/' allowed
mkdir -p ~/.config/host-disk-janitor
echo "$HOME/work/my-tool" >> ~/.config/host-disk-janitor/keep.txt
```

Check the effect with a dry-run: `node scripts/host-disk-janitor.mjs`.
