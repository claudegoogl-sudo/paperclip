/**
 * Shared pino-pretty options for both log targets (stdout and server.log).
 * Kept in its own module so tests can assert the rendered line shape against
 * the production options without importing the logger (which spawns the real
 * pino transport on import).
 *
 * `errorLikeObjectKeys` is narrowed to the standard `err` key only. pino-pretty's
 * default also treats `error` as an error-like object and renders it as an
 * indented error BLOCK on a continuation line — even in singleLine mode — so a
 * single-line grep/jq for an event name matched the line but showed no failure
 * reason (plugin logs conventionally carry the reason in a meta `error` key).
 * With `error` excluded it renders as a plain inline field on the event line;
 * standard `err` Error objects keep their multi-line block rendering.
 */
export const prettySharedOptions = {
  translateTime: "SYS:HH:MM:ss",
  ignore: "pid,hostname",
  singleLine: true,
  errorLikeObjectKeys: ["err"],
};
