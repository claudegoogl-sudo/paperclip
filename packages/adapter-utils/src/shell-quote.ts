/** POSIX single-quote a value for safe interpolation into a shell command line. */
export function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
