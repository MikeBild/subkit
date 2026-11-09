function abortError(reason: unknown): Error {
  const error = new Error(typeof reason === "string" && reason !== "" ? reason : "aborted");
  error.name = "AbortError";
  return error;
}

export function settleOnAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortError(signal.reason));
    };

    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
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
