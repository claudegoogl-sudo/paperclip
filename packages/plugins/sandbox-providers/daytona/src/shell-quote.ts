/**
 * Quotes one value for a POSIX shell. The result is one single-quoted word, so
 * the shell reads it as literal text and never expands or splits it. The function
 * closes the quote, adds an escaped single quote, and reopens the quote for each
 * single quote in the value.
 *
 * Shared by every place in this plugin that builds a shell command (duplex PTY
 * sessions, file-sync transfer commands, exec probes). Every path handed to
 * `sandbox.process.executeCommand` MUST pass through this so a value containing
 * shell metacharacters is transferred literally, never interpreted.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
