// In-process waits follow monotonic time; persisted deadlines remain UTC epoch milliseconds.
export function monotonicClock() {
  const utc = Date.now();
  const monotonic = performance.now();
  return () => utc + (performance.now() - monotonic);
}
