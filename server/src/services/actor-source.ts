import { forbidden } from "../errors.js";

/**
 * Canonical actor-source validation for service-layer actor synthesis.
 *
 * Authorization sources carry privilege: a `session`-sourced board actor can
 * satisfy the instance-admin elevation check inside `authorization.decide`,
 * and `local_implicit` is the implicit local board. Synthesizing either from
 * an unset or unknown input hands caller-supplied identifiers the most
 * privileged provenance available. Fail Securely: every synthesis site must
 * validate the source it was actually authenticated with and deny otherwise —
 * the most privileged sources are never a fallback.
 */
export const BOARD_ACTOR_SOURCES = ["local_implicit", "session", "board_key", "cloud_tenant"] as const;
export const AGENT_ACTOR_SOURCES = ["agent_key", "agent_jwt"] as const;

export type BoardActorSource = (typeof BOARD_ACTOR_SOURCES)[number];
export type AgentActorSource = (typeof AGENT_ACTOR_SOURCES)[number];

/**
 * Accepts only an explicitly passed, known board actor source.
 * Unset or unknown values deny (403) instead of falling back.
 */
export function requireBoardActorSource(source: unknown): BoardActorSource {
  for (const candidate of BOARD_ACTOR_SOURCES) {
    if (source === candidate) return candidate;
  }
  throw forbidden(
    "Board actor source is required for actor synthesis and must be one of: local_implicit, session, board_key, cloud_tenant",
  );
}

/**
 * Board sources a plugin may claim for actor synthesis. `local_implicit` is
 * excluded on purpose: it is the server-internal implicit board and yields an
 * unconditional allow, so it must never be claimable through a plugin RPC.
 */
export const PLUGIN_CLAIMABLE_BOARD_ACTOR_SOURCES = ["session", "board_key", "cloud_tenant"] as const;

export type PluginClaimableBoardActorSource = (typeof PLUGIN_CLAIMABLE_BOARD_ACTOR_SOURCES)[number];

/**
 * Accepts only an explicitly passed, plugin-representable board actor source.
 * Unset, unknown, or server-internal values deny (403) instead of falling back.
 */
export function requirePluginBoardActorSource(source: unknown): PluginClaimableBoardActorSource {
  for (const candidate of PLUGIN_CLAIMABLE_BOARD_ACTOR_SOURCES) {
    if (source === candidate) return candidate;
  }
  throw forbidden(
    'Plugin actor synthesis requires an explicit board actor source (session, board_key, or cloud_tenant); "local_implicit" is server-internal and cannot be claimed by plugins',
  );
}

/**
 * Accepts only an explicitly passed, known agent actor source.
 * Unset or unknown values deny (403) instead of falling back.
 */
export function requireAgentActorSource(source: unknown): AgentActorSource {
  for (const candidate of AGENT_ACTOR_SOURCES) {
    if (source === candidate) return candidate;
  }
  throw forbidden(
    "Agent actor source is required for actor synthesis and must be one of: agent_key, agent_jwt",
  );
}
