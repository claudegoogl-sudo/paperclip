---
title: Plugin Capability Escalation
summary: Board-gated upgrades when a plugin upgrade requests new capabilities
---

When a plugin upgrade asks for **capabilities the installed version did not already hold**, Paperclip does not apply it silently. The upgrade is parked in an `upgrade_pending` state and a board approval is filed. The new code only runs once you approve it. This keeps a routine "bump the version" action from quietly broadening what a plugin is allowed to do.

## What triggers the gate

The gate compares the installed manifest's `capabilities` against the upgrade target's. Only **added** capabilities matter:

- New version requests a **superset** (e.g. `["issues.read"]` → `["issues.read", "issues.create"]`) → **gated**.
- New version requests the **same or fewer** capabilities → applies immediately, no approval.

A re-run of the same gated upgrade while it is parked **converges on the existing approval** — it never files a second one. Approving, applying, and re-trying are all idempotent.

## Lifecycle

```
ready ──upgrade (new caps)──> upgrade_pending ──approve──> ready (new version + caps)
                                              └──reject──> ready (original version + caps, fully restored)
```

- **Park:** the plugin row stays at its current version/capabilities; status flips to `upgrade_pending`. Plugin config, state, and secret bindings are untouched.
- **Approve:** the staged version and capabilities are applied, the worker is reactivated, and status returns to `ready`.
- **Reject:** the parked upgrade is discarded and the plugin is restored to `ready` at its original version/capabilities. Reject is a pure status restore — parking never mutated version or caps.

## What the board sees

The approval reuses the standard `request_board_approval` type. Capability-escalation approvals are distinguished by a payload discriminator:

```json
{
  "kind": "plugin_capability_escalation",
  "pluginId": "…",
  "pluginKey": "paperclip.example",
  "fromVersion": "0.1.0",
  "toVersion": "0.2.0",
  "fromCapabilities": ["issues.read"],
  "toCapabilities": ["issues.read", "issues.create"],
  "addedCapabilities": ["issues.create"],
  "digest": "sha256:…"
}
```

Review `addedCapabilities` — that is the exact set of new powers the upgrade is asking for. Approve or reject from the Approvals page like any other approval; resolution is wired straight back into the plugin lifecycle.

The `digest` is a content hash (`sha256:<hex>`) of the exact package captured when the upgrade was parked. On approval the loader pins the applied package to this digest: a package that declares the approved version and capabilities but carries different code (a source swapped after approval) is rejected. Approvals filed before this anchor existed have no `digest` and fall back to version + capability checks only.

At park time the loader also copies the package into a content-addressed snapshot store (`<local plugin dir>/.upgrade-snapshots/<digest>`). Approval applies the snapshot, not the original source directory, so the loaded bytes are host-controlled. The copy is link-safe and bounded: it dereferences only symlinks that resolve inside the approved package, refuses devices, FIFOs, and sockets, and stops the park with an error if the tree exceeds 1 GiB or 200,000 files. A symlink that points outside the package (for example into host data) is skipped, so its contents never enter the snapshot. Snapshots no longer referenced by any installed plugin are pruned on apply, revert, and uninstall.

## Install and reinstall

Install is not a side door around the gate.

- **Reinstall over a soft-uninstalled plugin.** Reinstall reuses the same plugin id and all plugin data (config, secret refs, state, jobs, webhooks). The new manifest is diffed against the stored (granted) capabilities, exactly like an upgrade. Added capabilities park the plugin in `upgrade_pending` and file the same approval with `"origin": "install"`. Same or fewer capabilities: installs as before. Without `PAPERCLIP_PLUGIN_ESCALATION_COMPANY_ID`, a capability-adding reinstall is refused with the same error as `/upgrade`.
- **Fresh install** (no row, or after uninstall with `purge=true`). When the gateway is configured, a manifest that declares any capability outside `PAPERCLIP_PLUGIN_INSTALL_CAPABILITY_ALLOWLIST` (comma separated; default empty) is parked. The approval lists all declared capabilities (`fromCapabilities: []`). Until approval, the stored manifest grants no capabilities. Without the gateway, fresh installs behave as before.
- **Approve** → the approved package is applied and the plugin goes to `ready`. **Reject** → an install-origin park goes to `uninstalled` (inactive), not `ready`.
- **Gateway error** during install → the install fails and nothing is activated (fresh: no row; reinstall: stays `uninstalled`).
- **Boot auto-install** of bundled plugins (for example the kubernetes sandbox provider) is exempt: its path comes from host env and the host image, so it is already host-controlled.

`POST /api/plugins/install` returns the plugin record plus `capabilities`, `addedCapabilities` and `approvalId` (`null` when not parked). `paperclipai plugin install` prints the capabilities and the approval id. The UI shows them in the install toast. The `plugin.installed` activity entry records `capabilities` and `approvalId`. Log line on park: `plugin-loader: install requires capability approval — parked in upgrade_pending pending board approval`.

## Configuration

The escalation gateway is only wired up when the server knows which company owns the board approval queue for plugin upgrades. Set:

```
PAPERCLIP_PLUGIN_ESCALATION_COMPANY_ID=<company-id>
```

If this is unset, the upgrade route **fails closed**: a cap-escalating upgrade is refused rather than silently applied. Same-or-fewer-capability upgrades are unaffected.

## Observability

Each transition emits a structured log line you can grep in production:

- `capability-escalation: filed board approval for plugin capability escalation` (on park) — includes `approvalId`, `companyId`, `pluginId`, `toVersion`, `addedCapabilities`.
- `plugin-loader: upgrade introduces new capabilities — parked in upgrade_pending pending board approval`.
- `plugin-loader: upgrade already parked for this target — converging without re-filing` (idempotent re-run).
- `capability-escalation: applying board decision to parked plugin upgrade` (on approve/reject) — includes `outcome`.
- `plugin lifecycle: parked upgrade approved — applied and returning to ready` / `… rejected — restored to ready`.
- `plugin-loader: snapshot skipped symlink whose target escapes the package root` (on park) — the approved source tree contained a link pointing outside the package; its target is not copied.
- `plugin-loader: pruned unreferenced upgrade snapshot` (on apply, revert, or uninstall) — an old snapshot left the content-addressed store.

## A parked plugin cannot be enabled

A plugin in `upgrade_pending` cannot be enabled. `POST /api/plugins/:id/enable` returns 400. Only the board decision moves it on: approve applies the package, reject reverts it.

- A reinstall park does not change the row. Version, manifest, `packageName` and `packagePath` keep the granted values. The new source is stored on the approval and applied only on approve. A rejected reinstall stays `uninstalled` on its previous source.
- Activation refuses a package on disk whose manifest adds capabilities the plugin was not granted. Log line: `plugin-loader: on-disk manifest adds capabilities the plugin was not granted — refusing to activate`. Use `/upgrade` so the board can approve them.
- Fresh install with no escalation gateway configured is not gated (legacy behavior). Configure the gateway on deployments that need the gate.

## Happy-path walkthrough

1. Plugin `paperclip.example` is installed at `0.1.0` with `["issues.read"]`.
2. An admin calls `POST /api/plugins/:id/upgrade` targeting `0.2.0`, whose manifest declares `["issues.read", "issues.create"]`.
3. The route returns `status: "upgrade_pending"` with an `approvalId`. The plugin keeps running `0.1.0`.
4. A `plugin_capability_escalation` approval appears in the board queue listing `addedCapabilities: ["issues.create"]`.
5. **Approve** → the loader applies `0.2.0`, the worker reactivates with the new capability, and the plugin returns to `ready`. **Reject** → the plugin stays on `0.1.0` with its original capability set.

The executable reference for this flow is the end-to-end test
`server/src/__tests__/plugin-capability-escalation.test.ts`, which exercises park, idempotent re-file, approve (version + caps applied, config preserved), and reject (full restore) against an embedded Postgres instance.
