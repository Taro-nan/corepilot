/** Share a successful staging operation while allowing a failed attempt to be retried. */
export function createStagingCache<T>(stage: (signal?: AbortSignal) => Promise<T>): (signal?: AbortSignal) => Promise<T> {
  let pending: Promise<T> | undefined;
  return (signal) => {
    if (!pending) {
      const attempt = Promise.resolve().then(() => stage(signal));
      pending = attempt;
      void attempt.catch(() => { if (pending === attempt) pending = undefined; });
    }
    return pending;
  };
}
