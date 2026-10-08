export const PROVIDER_RESPONSE_TIMEOUT_MS = 120_000;

export type ResponseFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function responseTimeoutError(timeoutMs: number): DOMException {
  return new DOMException(`First chunk timeout of ${timeoutMs}ms exceeded`, "TimeoutError");
}

export function fetchWithResponseTimeout(
  timeoutMs: number = PROVIDER_RESPONSE_TIMEOUT_MS,
  base: ResponseFetch = (input, init) => fetch(input, init),
): ResponseFetch {
  return async (input, init) => {
    const outer = init?.signal ?? null;
    if (outer?.aborted) throw outer.reason;
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(outer?.reason);
    outer?.addEventListener("abort", forwardAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = responseTimeoutError(timeoutMs);
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    try {
      return await Promise.race([base(input, { ...init, signal: controller.signal }), expired]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      outer?.removeEventListener("abort", forwardAbort);
    }
  };
}
