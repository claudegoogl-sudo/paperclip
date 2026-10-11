// Per-agent git identity derivation.
//
// Every git commit made from an agent run — by the agent's own shell commands
// (GIT_* env injected into the adapter process) or by host-executed git
// operations (workspace realize/repair/rescue paths) — is attributed to the
// agent that owns the run. The identity is derived purely from the agent row
// (name + id + companyId), so it is stable across runs and needs no tenant
// configuration.
//
// Identity scheme (documented in docs/guides/agent-developer/agent-git-identity.md):
//   user.name  "Paperclip Agent <slug> (<first 8 chars of agent id>)"
//   user.email "<slug>.<agent id>@<company id>.agents.paperclip.invalid"
// - <slug> is the agent display name folded to a lowercase ASCII slug
//   (NFKD + combining-mark strip + non-[a-z0-9._-] runs collapsed to "-").
//   A name with no usable ASCII (empty, CJK-only, symbols-only) is omitted;
//   the email then falls back to the bare agent id so it is never empty and
//   never name-collision-prone.
// - The full agent id in the email local part makes the identity
//   collision-free across agents and companies by construction, and the
//   company id in the domain makes it company-discriminated.
// - ".invalid" is a reserved TLD (RFC 2606), so a derived identity can never
//   be confusable with a real user email, and an agent name that mimics an
//   email address cannot produce a deliverable-looking identity.
// - The first-8 id fragment in the display name gives humans a short,
//   grep-friendly anchor; the email carries the exact id for tracing.

export interface AgentGitIdentityInput {
  id: string;
  name?: string | null;
  companyId: string;
}

export interface AgentGitIdentity {
  /** Value for git user.name / GIT_AUTHOR_NAME / GIT_COMMITTER_NAME. */
  name: string;
  /** Value for git user.email / GIT_AUTHOR_EMAIL / GIT_COMMITTER_EMAIL. */
  email: string;
}

/** Longest name-derived segment carried into the git identity. */
export const AGENT_GIT_IDENTITY_NAME_SEGMENT_MAX_CHARS = 48;

/**
 * Reserved-tld email domain so a derived agent identity can never collide
 * with (or be confusable with) a real user email.
 */
export const AGENT_GIT_IDENTITY_EMAIL_DOMAIN = "agents.paperclip.invalid";

const SLUG_FORBIDDEN_RE = /[^a-z0-9._-]+/g;
const SLUG_EDGE_JUNK_RE = /^[._-]+|[._-]+$/g;

function foldToAsciiSlug(value: string): string {
  const lowered = value.toLowerCase();
  // NFKD + combining-mark strip folds accented latin and many lookalike
  // codepoints to their ASCII base; anything still non-ASCII is dropped by
  // the slug character class below.
  const folded = lowered.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const slug = folded.replace(SLUG_FORBIDDEN_RE, "-").replace(SLUG_EDGE_JUNK_RE, "");
  if (slug.length <= AGENT_GIT_IDENTITY_NAME_SEGMENT_MAX_CHARS) return slug;
  return slug.slice(0, AGENT_GIT_IDENTITY_NAME_SEGMENT_MAX_CHARS).replace(/[._-]+$/, "");
}

function sanitizeIdSegment(value: string, fallback: string): string {
  const segment = value.replace(/[^a-zA-Z0-9-]/g, "");
  return segment.length > 0 ? segment : fallback;
}

/**
 * Derive the git identity for an agent. Pure and deterministic: the same
 * agent row always yields the same identity, across runs and hosts.
 */
export function deriveAgentGitIdentity(agent: AgentGitIdentityInput): AgentGitIdentity {
  const idSegment = sanitizeIdSegment(agent.id, "agent");
  const companySegment = sanitizeIdSegment(agent.companyId, "company");
  const slug = foldToAsciiSlug(agent.name ?? "");
  const emailLocal = slug.length > 0 ? `${slug}.${idSegment}` : idSegment;
  const displayName = slug.length > 0 ? `Paperclip Agent ${slug} (${idSegment.slice(0, 8)})` : `Paperclip Agent (${idSegment.slice(0, 8)})`;
  return {
    name: displayName,
    email: `${emailLocal}@${companySegment}.${AGENT_GIT_IDENTITY_EMAIL_DOMAIN}`,
  };
}

/**
 * The GIT_* env block injected into adapter processes (and applied to
 * host-executed git operations) so commits are attributed to the agent by
 * default. Names and emails only — no secrets, no capability.
 */
export function buildAgentGitIdentityEnv(agent: AgentGitIdentityInput): Record<string, string> {
  const identity = deriveAgentGitIdentity(agent);
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}
