const SESSION_DISPLAY_ID_LENGTH = 16;

/** Adapters may persist a 16-char display id in session_id_after while callers hold the full id. */
export function sessionIdLookupCandidates(sessionId: string): string[] {
  const short = sessionId.slice(0, SESSION_DISPLAY_ID_LENGTH);
  return short === sessionId ? [sessionId] : [sessionId, short];
}
