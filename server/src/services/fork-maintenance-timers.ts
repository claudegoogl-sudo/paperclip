/**
 * Test-harness switch for the fork-only always-on maintenance timers (egress posture sweep,
 * task-bridge renewal sweep, run-history / plugin-webhook-delivery / board-api-key-auth-event retention).
 * ON unless the process environment says exactly `off`. Environment only: no API route, DB row
 * or config document may set it, so no tenant or operator surface can silence these checks.
 */
export function forkMaintenanceTimersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAPERCLIP_FORK_MAINTENANCE_TIMERS !== "off";
}
