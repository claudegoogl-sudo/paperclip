import { AsyncLocalStorage } from "node:async_hooks";

/**
 * postgres.js runs a query to completion even when nobody is waiting for its
 * result any more, so a request whose HTTP client has disconnected keeps its
 * pool connection until the query finishes or `statement_timeout` fires.
 * This module is the missing link between the request lifecycle and
 * the pool: the database layer has no notion of a request, so rather than
 * threading an `AbortSignal` through every service and repository call, the
 * owner of the request lifecycle opens a cancellation scope around its handler
 * and the pool client registers each query it creates inside that scope.
 * Aborting the scope cancels those queries, which releases their connections.
 *
 * A drizzle query builder does not touch the database until it is awaited, so
 * only queries awaited inside the scope are cancellable. Handing a builder out
 * of the scope and awaiting it elsewhere silently opts that query out.
 */

type TrackableQuery = {
  cancel: () => void;
  /** postgres.js sets this to the backend key when it writes the query out. */
  state: unknown;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

type ScopeState = {
  readonly liveQueries: Set<TrackableQuery>;
  cancelledQueryCount: number;
  aborted: boolean;
};

const activeScope = new AsyncLocalStorage<ScopeState>();

export type QueryCancellationScope = {
  /** Runs `fn` with this scope active; queries created under it are cancellable. */
  run<T>(fn: () => T): T;
  /** Queries this scope has asked postgres.js to cancel — the abort's effect. */
  readonly cancelledQueryCount: number;
};

const CANCEL_DISPATCH_POLL_MS = 5;
/**
 * How long to wait for a query to reach a backend before cancelling regardless.
 * A query with no backend after this long is queued behind a busy pool, where
 * cancelling is a clean dequeue-and-reject; the bound only exists so a query
 * that never reaches one cannot be left running forever.
 */
const CANCEL_DISPATCH_TIMEOUT_MS = 1_000;

/**
 * Cancels a query, but not before postgres.js has written it to a backend.
 *
 * Cancelling in the window between "handed to a connection" and "written" is
 * worse than not cancelling at all: `Connection.execute` skips a query that is
 * already cancelled, and the connection it was going to run on is then never
 * handed back — it sits in the pool's `connecting`/`full` queue with nothing in
 * flight to release it. That is the exact leak this module exists to prevent, so
 * we wait for `query.state` (the backend key, assigned as the query is written)
 * before asking the pool to cancel. `query-cancellation.test.ts` covers the case
 * that produced it: a scope that aborted before the handler issued its query,
 * which lands on a connection that is still being established.
 */
function scheduleCancel(state: ScopeState, query: TrackableQuery, waitedMs: number): void {
  setTimeout(() => {
    // Finished on its own in the meantime: nothing to cancel, and cancelling a
    // settled query would leave a dangling cancellation request behind.
    if (!state.liveQueries.has(query)) return;

    if (!query.state && waitedMs < CANCEL_DISPATCH_TIMEOUT_MS) {
      scheduleCancel(state, query, waitedMs + CANCEL_DISPATCH_POLL_MS);
      return;
    }

    state.liveQueries.delete(query);
    // The result is observed because postgres.js reports cancellation failures
    // through it, and an unobserved rejection would take the process down.
    void Promise.resolve(query.cancel() as unknown).catch(() => {});
  }, CANCEL_DISPATCH_POLL_MS).unref();
}

function requestCancel(state: ScopeState, query: TrackableQuery): void {
  state.cancelledQueryCount += 1;
  scheduleCancel(state, query, 0);
}

export function createQueryCancellationScope(signal: AbortSignal): QueryCancellationScope {
  const state: ScopeState = {
    liveQueries: new Set<TrackableQuery>(),
    cancelledQueryCount: 0,
    aborted: signal.aborted,
  };

  if (!signal.aborted) {
    signal.addEventListener(
      "abort",
      () => {
        state.aborted = true;
        for (const query of [...state.liveQueries]) requestCancel(state, query);
      },
      { once: true },
    );
  }

  return {
    run: (fn) => activeScope.run(state, fn),
    get cancelledQueryCount() {
      return state.cancelledQueryCount;
    },
  };
}

/**
 * Registers a freshly created postgres.js query with the active cancellation
 * scope, if any. Returns the same query object — callers (drizzle) chain
 * `.values()` on it and rely on its identity.
 */
function trackQuery<Query>(query: Query): Query {
  const state = activeScope.getStore();
  if (!state) return query;

  const trackable = query as TrackableQuery;
  state.liveQueries.add(trackable);

  // postgres.js settles a query through these own-property callbacks. Wrapping
  // them is how we learn a query finished without attaching a `.then`, which
  // would eagerly execute it. `query-cancellation.test.ts` locks this in: a
  // finished query must not be cancelled by a later abort.
  const { resolve, reject } = trackable;
  trackable.resolve = (value) => {
    state.liveQueries.delete(trackable);
    return resolve(value);
  };
  trackable.reject = (error) => {
    state.liveQueries.delete(trackable);
    return reject(error);
  };

  // A handler that keeps querying after its client vanished gets the same
  // treatment as one that was mid-query when it happened.
  if (state.aborted) requestCancel(state, trackable);

  return query;
}

type QueryFactory = {
  unsafe: (...args: never[]) => unknown;
};

/**
 * Makes every query created through `sql.unsafe(...)` cancellable by the active
 * scope. Drizzle's postgres-js driver routes all of its statements through
 * `unsafe`, so patching it covers the whole query surface of a `Db`.
 * Transactions are deliberately not covered: `sql.begin` hands the callback its
 * own reserved client, and cancelling a statement mid-transaction would abort
 * work the caller may still be committing.
 */
export function enableQueryCancellation<Sql extends QueryFactory>(sql: Sql): Sql {
  const unsafe = sql.unsafe.bind(sql) as Sql["unsafe"];
  sql.unsafe = ((...args: Parameters<Sql["unsafe"]>) =>
    trackQuery(unsafe(...args))) as Sql["unsafe"];
  return sql;
}
