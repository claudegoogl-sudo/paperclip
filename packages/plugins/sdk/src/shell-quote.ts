/**
 * Quotes one value for a POSIX shell. The result is one single-quoted word, so
 * the shell reads it as literal text and never expands or splits it. The
 * function closes the quote, adds an escaped single quote, and reopens the
 * quote for each single quote in the value.
 *
 * Every sandbox-provider plugin that builds a shell command string (exec
 * probes, env injection, file transfer) needs this; it lived as a byte-for-byte
 * duplicate in several provider packages before moving here.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Whether `value` is safe to use as a bare (unquoted) POSIX shell env var name. */
export function isValidShellEnvKey(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}
