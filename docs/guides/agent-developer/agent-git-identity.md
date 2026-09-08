---
title: Agent Git Identity
summary: How agent-run commits are attributed, and how to trace a commit back to a run
---

Every git commit made from an agent run is attributed to that agent by default. The host injects a per-agent git identity into the run's process environment, and applies the same identity to host-executed git operations that create commits or branches on behalf of a run (workspace rescue, worktree realize, branch coherence repair). No tenant configuration is required.

## The identity scheme

The identity is derived deterministically from the agent row (name, id, company id). The same agent always produces the same identity, across runs and hosts.

| Field | Value |
|-------|-------|
| `user.name` | `Paperclip Agent <slug> (<first 8 chars of agent id>)` |
| `user.email` | `<slug>.<agent id>@<company id>.agents.paperclip.invalid` |

- `<slug>` is the agent display name folded to lowercase ASCII: accented characters are normalized (`Cöder` → `coder`), and characters outside `[a-z0-9._-]` collapse to `-`. Names with no usable ASCII (empty, CJK-only, symbols-only) are omitted; the email then falls back to the bare agent id.
- The full agent id in the email local part makes the identity **collision-free across agents and companies** — two agents named "QA" can never share an identity, and duplicate names inside one company stay distinct.
- The company id in the domain makes the identity **company-discriminated**.
- `.invalid` is a reserved TLD (RFC 2606). A derived identity can never be confusable with a real user email, and an agent named like an email address cannot produce a deliverable-looking identity.

### Example

Agent "Coder" (`558b662c-0f1f-473a-ab7d-d4e56fb3c29b`) in company `d49b266c-50dc-42c5-b45e-308c7f3ffc1f`:

```
user.name  Paperclip Agent coder (558b662c)
user.email coder.558b662c-0f1f-473a-ab7d-d4e56fb3c29b@d49b266c-50dc-42c5-b45e-308c7f3ffc1f.agents.paperclip.invalid
```

The injected environment variables (author AND committer):

```
GIT_AUTHOR_NAME=Paperclip Agent coder (558b662c)
GIT_AUTHOR_EMAIL=coder.558b662c-...@d49b266c-...agents.paperclip.invalid
GIT_COMMITTER_NAME=Paperclip Agent coder (558b662c)
GIT_COMMITTER_EMAIL=coder.558b662c-...@d49b266c-...agents.paperclip.invalid
```

These names and emails only — no secrets, no capability. Env vars set by user/adapter configuration may still override them for a specific run; the `PAPERCLIP_*` runtime variables cannot be overridden that way.

## Tracing a commit back to an agent run

1. Read the committer email from the commit:

   ```
   git log -1 --format='%an <%ae> / %cn <%ce>'
   ```

2. The agent id is the middle segment of the email local part; the company id is the domain's first label. Look the agent up: `GET /api/companies/<company id>/agents` → find `<agent id>`.

3. To find the run that produced it, list runs for the agent around the commit date, or use the activity log filtered on the agent — the commit itself carries no run id (git identities are stable across runs by design), so the run is resolved from the agent's run history.

## What this does not guarantee

Identity injection is **default attribution, not non-repudiation**. The injected `GIT_*` variables and the host-applied identity are defaults a well-behaved process uses; a hostile agent process can still forge the author and committer on its own commits — `git commit --author=...` and its own environment overrides are ordinary git features the agent may call. A tenant separation-of-duties control keyed only on `git log --author` in an agent-writable checkout is therefore **not sound against a hostile agent**. The attribution is sound for what it targets: accidental misattribution (a commit landing under whatever identity happens to live in the checkout config) and repositories the agent reaches only via controlled paths — host-executed git operations and host-assembled process environments — rather than arbitrary process execution inside the repo.

## Workspace durability: where agent commits belong

There are two kinds of agent working directories, with different guarantees:

- **Agent fallback workspace** (`workspaces/<agentId>`): an unversioned scratch directory with **no durability guarantee**. It has no `.git`, and it is not backed up. Anything valuable committed only here does not exist. Treat it as a place to keep unversioned working state between heartbeats, nothing more.
- **Managed project workspaces / execution workspaces** (`git_worktree` strategy): versioned work belongs here. Their close path refuses to lose dirty or unpushed work — `inspectGitCloseReadiness` fails the close when a worktree would be torn down with uncommitted changes or unpushed commits, and the runtime quarantines incoherent state onto a rescue branch instead of discarding it. Commits these paths create on behalf of a run carry the agent identity too.

Happy path: set (or reuse) a project workspace with a git remote for work that must survive, let the agent commit there, and treat the fallback dir as scratch.

## For adapter authors

If you write a custom adapter, build the child process environment from the adapter-utils helpers rather than a hand-rolled copy so the identity stays consistent:

```ts
import { buildPaperclipEnv } from "@paperclipai/adapter-utils";

const env = buildPaperclipEnv(agent); // PAPERCLIP_* runtime vars + the four GIT_* identity vars
```

Alternatively, to inject only the git identity block:

```ts
import { buildAgentGitIdentityEnv } from "@paperclipai/adapter-utils";

const gitEnv = buildAgentGitIdentityEnv({ id: agent.id, name: agent.name, companyId: agent.companyId });
```

## Host-side attribution (what the server does)

- **Adapter process env** — the launch-path env assembly (`buildPaperclipEnv` in `@paperclipai/adapter-utils`) injects the four `GIT_*` variables for every agent run, so any `git commit` the agent's own shell commands make is attributed to the agent. Env wins over a checkout's own configured identity, which is what fixes commits landing as whatever identity happened to live in the repo config.
- **Host-executed git operations** — workspace runtime operations that create commits or branches on behalf of a run (rescue-branch commit, `checkout -b`/`-B` repairs, `worktree add -b`, unstarted-worktree refresh) pass the same identity via `GIT_*` environment. Read-only git operations ignore identity env, so only the mutating call sites thread it.
- **User sessions** — no agent identity is injected where a human identity applies; user-driven sessions keep their existing behavior.

Related: [Execution workspaces and runtime services](/guides/board-operator/execution-workspaces-and-runtime-services).
