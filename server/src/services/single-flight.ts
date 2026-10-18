export function createSingleFlight<Args extends unknown[]>(
  fn: (...args: Args) => Promise<void>,
): (...args: Args) => Promise<void> {
  let running = false;
  return async (...args: Args) => {
    if (running) return;
    running = true;
    try {
      await fn(...args);
    } finally {
      running = false;
    }
  };
}
