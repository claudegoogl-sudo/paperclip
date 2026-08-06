import { createHmac, timingSafeEqual } from "node:crypto";
import { resolvePaperclipInstanceId } from "./home-paths.js";

interface JwtHeader {
  alg: string;
  typ?: string;
}

export interface LocalAgentJwtClaims {
  sub: string;
  company_id: string;
  adapter_type: string;
  run_id: string;
  responsible_user_id?: string | null;
  iat: number;
  exp: number;
  iss?: string;
  aud?: string;
  instance_id?: string;
  jti?: string;
}

const JWT_ALGORITHM = "HS256";

function parseNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function jwtConfig() {
  const secret = process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim() || process.env.BETTER_AUTH_SECRET?.trim();
  if (!secret) return null;

  return {
    secret,
    ttlSeconds: parseNumber(process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS, 60 * 60),
    issuer: process.env.PAPERCLIP_AGENT_JWT_ISSUER ?? "paperclip",
    audience: process.env.PAPERCLIP_AGENT_JWT_AUDIENCE ?? "paperclip-api",
    // The control-plane instance this process belongs to. The live plane runs as
    // "default"; every worktree/fork instance gets a distinct id (its worktree
    // name) even though it deliberately shares PAPERCLIP_AGENT_JWT_SECRET with
    // the source instance. Folding this into the signing-key derivation is what
    // prevents a fork-minted token from authenticating against the live plane.
    instanceId: resolvePaperclipInstanceId(),
  };
}

/**
 * Derive a per-instance, per-company signing key from the master JWT secret,
 * the control-plane instanceId, and a companyId.
 *
 * Two isolation properties fall out of this derivation:
 *  - Per-company: a JWT signed for company A cannot be reused to authenticate
 *    as an agent in company B, even if the raw token leaks.
 *  - Per-instance: a JWT minted by a worktree/fork control-plane instance
 *    cannot authenticate against the live plane, even though forks
 *    deliberately share the same master secret (it is copied into worktree
 *    envs by provisioning). The live plane derives its key from its own
 *    instanceId ("default"), so a fork token — signed under the fork's
 *    instanceId — never matches. See PAP-12896 for the incident this closes.
 *
 * The instance-wide master secret is never used to sign OR verify tokens.
 * The previous raw-master verification fallback (instance-agnostic, retained
 * only to grandfather tokens issued before per-company derivation) has been
 * removed: it was an instance-isolation bypass and every live instance now
 * mints exclusively under the derived key with a 1h TTL, so any legacy token
 * has long since expired. There is no escape hatch; if raw-master
 * verification is ever required again it must be reintroduced explicitly.
 *
 * The derivation domain-separates with the `jwt:` prefix so the same master
 * secret can safely be reused for other HMAC purposes without key reuse.
 */
function deriveCompanySigningKey(masterSecret: string, companyId: string, instanceId: string): string {
  return createHmac("sha256", masterSecret).update(`jwt:${instanceId}:${companyId}`).digest("hex");
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signPayload(secret: string, signingInput: string) {
  return createHmac("sha256", secret).update(signingInput).digest("base64url");
}

function parseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function safeCompare(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function createLocalAgentJwt(
  agentId: string,
  companyId: string,
  adapterType: string,
  runId: string,
  responsibleUserId?: string | null,
) {
  const config = jwtConfig();
  if (!config) return null;

  const now = Math.floor(Date.now() / 1000);
  const claims: LocalAgentJwtClaims = {
    sub: agentId,
    company_id: companyId,
    adapter_type: adapterType,
    run_id: runId,
    responsible_user_id: responsibleUserId?.trim() || null,
    iat: now,
    exp: now + config.ttlSeconds,
    iss: config.issuer,
    aud: config.audience,
    instance_id: config.instanceId,
  };

  const header = {
    alg: JWT_ALGORITHM,
    typ: "JWT",
  };

  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;
  // Sign with the per-instance, per-company derived key so a leaked token
  // cannot be reused across tenants and a fork-minted token cannot authenticate
  // against a different control-plane instance.
  const signingKey = deriveCompanySigningKey(config.secret, companyId, config.instanceId);
  const signature = signPayload(signingKey, signingInput);

  return `${signingInput}.${signature}`;
}

export function verifyLocalAgentJwt(token: string): LocalAgentJwtClaims | null {
  if (!token) return null;
  const config = jwtConfig();
  if (!config) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, claimsB64, signature] = parts;

  const header = parseJson(base64UrlDecode(headerB64));
  if (!header || header.alg !== JWT_ALGORITHM) return null;

  const claims = parseJson(base64UrlDecode(claimsB64));
  if (!claims) return null;

  const claimedCompanyId = typeof claims.company_id === "string" ? claims.company_id : null;
  if (!claimedCompanyId) return null;

  const signingInput = `${headerB64}.${claimsB64}`;
  // Verify only under the per-instance, per-company derived key (current
  // tokens), deriving under THIS control plane's own instanceId. A token
  // minted by a worktree/fork instance was signed under a different
  // instanceId, so it will not match here — that is the boundary that keeps
  // fork tokens out of the live plane (PAP-12896/PAP-12899).
  //
  // The raw-master verification fallback has been removed. It was
  // instance-agnostic, so any token forged with the shared master secret
  // would have validated across control-plane instances. Live verification
  // confirms every agent JWT is now minted under the derived key and the 1h
  // TTL has aged out the legacy window, so the fallback is fail-closed by
  // default with no escape hatch. A leaked master secret can no longer be
  // used to forge tenant-spanning tokens against this verifier.
  const perCompanyKey = deriveCompanySigningKey(config.secret, claimedCompanyId, config.instanceId);
  const perCompanySig = signPayload(perCompanyKey, signingInput);
  const signatureOk = safeCompare(signature, perCompanySig);
  if (!signatureOk) return null;

  const sub = typeof claims.sub === "string" ? claims.sub : null;
  const adapterType = typeof claims.adapter_type === "string" ? claims.adapter_type : null;
  const runId = typeof claims.run_id === "string" ? claims.run_id : null;
  const responsibleUserClaim = Object.hasOwn(claims, "responsible_user_id")
    ? typeof claims.responsible_user_id === "string" && claims.responsible_user_id.trim()
      ? claims.responsible_user_id.trim()
      : null
    : undefined;
  const iat = typeof claims.iat === "number" ? claims.iat : null;
  const exp = typeof claims.exp === "number" ? claims.exp : null;
  if (!sub || !adapterType || !runId || !iat || !exp) return null;
  const companyId = claimedCompanyId;

  const now = Math.floor(Date.now() / 1000);
  if (exp < now) return null;

  const issuer = typeof claims.iss === "string" ? claims.iss : undefined;
  const audience = typeof claims.aud === "string" ? claims.aud : undefined;
  if (issuer && issuer !== config.issuer) return null;
  if (audience && audience !== config.audience) return null;

  // Enforce the minting instance when the claim is present. The instance-scoped
  // signing key above is the real cryptographic boundary; this claim check is
  // defense-in-depth that yields a clean, cheap rejection of any token that
  // happens to carry a mismatched instance_id. The raw-master fallback that
  // used to make this check load-bearing for instance isolation has been
  // removed; every accepted token is now bound to a derived key under THIS
  // instance's id, so enforcement here is conditional — matching how iss/aud
  // are handled above.
  const instanceClaim = typeof claims.instance_id === "string" ? claims.instance_id : undefined;
  if (instanceClaim && instanceClaim !== config.instanceId) return null;

  return {
    sub,
    company_id: companyId,
    adapter_type: adapterType,
    run_id: runId,
    ...(responsibleUserClaim !== undefined ? { responsible_user_id: responsibleUserClaim } : {}),
    iat,
    exp,
    ...(issuer ? { iss: issuer } : {}),
    ...(audience ? { aud: audience } : {}),
    ...(instanceClaim ? { instance_id: instanceClaim } : {}),
    jti: typeof claims.jti === "string" ? claims.jti : undefined,
  };
}
