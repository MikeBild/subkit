// Hard settlement boundary for HTTP transports.
//
// The caller still aborts the real fetch through the same AbortSignal. This
// wrapper additionally guarantees that the promise observed by the execution
// engine rejects when that signal fires, even if a runtime transport keeps a
// stalled fetch promise pending after abort.

function abortError(reason: unknown): Error {
  const error = new Error(typeof reason === "string" && reason !== "" ? reason : "aborted");
  error.name = "AbortError";
  return error;
}

export function settleOnAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal.reason));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortError(signal.reason));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
