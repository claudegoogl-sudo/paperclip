/**
 * Auth-failure circuit breaker (PLA-11434). Per-adapter-type, in-memory.
 * After N consecutive auth failures the breaker opens: new dispatch is held.
 * One probe run is allowed per cooldown (half-open). First success closes it.
 */
export const AUTH_FAILURE_ERROR_CODES = new Set(["claude_auth_required"]);
export const AUTH_BREAKER_THRESHOLD = 3;
export const AUTH_BREAKER_PROBE_COOLDOWN_MS = 5 * 60_000;

type State = { failures: number; openedAt: number | null; lastProbeAt: number };

export function createAuthCircuitBreaker(opts?: { threshold?: number; probeCooldownMs?: number; now?: () => number }) {
  const threshold = opts?.threshold ?? AUTH_BREAKER_THRESHOLD;
  const cooldown = opts?.probeCooldownMs ?? AUTH_BREAKER_PROBE_COOLDOWN_MS;
  const now = opts?.now ?? Date.now;
  const states = new Map<string, State>();
  const get = (k: string) => {
    let s = states.get(k);
    if (!s) states.set(k, (s = { failures: 0, openedAt: null, lastProbeAt: 0 }));
    return s;
  };
  return {
    /** Record a terminal run. Returns "opened" exactly once per trip (alert once), "closed" on resume. */
    recordOutcome(provider: string, input: { status: string; errorCode?: string | null; error?: string | null }): "opened" | "closed" | null {
      const s = get(provider);
      const isAuth =
        input.status === "failed" &&
        ((input.errorCode != null && AUTH_FAILURE_ERROR_CODES.has(input.errorCode)) ||
          /No API key for provider/i.test(input.error ?? ""));
      if (isAuth) {
        s.failures += 1;
        if (s.openedAt === null && s.failures >= threshold) {
          s.openedAt = now();
          s.lastProbeAt = s.openedAt;
          return "opened";
        }
        return null;
      }
      if (input.status === "succeeded") {
        const wasOpen = s.openedAt !== null;
        s.failures = 0;
        s.openedAt = null;
        return wasOpen ? "closed" : null;
      }
      return null;
    },
    /** True when new dispatch for this provider should be held. Grants one probe per cooldown. */
    shouldHold(provider: string): boolean {
      const s = states.get(provider);
      if (!s || s.openedAt === null) return false;
      if (now() - s.lastProbeAt >= cooldown) {
        s.lastProbeAt = now();
        return false;
      }
      return true;
    },
    isOpen: (provider: string) => states.get(provider)?.openedAt != null,
  };
}
