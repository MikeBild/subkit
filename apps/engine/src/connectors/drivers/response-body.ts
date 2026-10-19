export class HttpRequestInvalidError extends Error {
  constructor(
    message: string,
    public readonly path: string,
  ) {
    super(message);
    this.name = "HttpRequestInvalidError";
  }
}

export async function readBodyBytesCapped(
  res: Response,
  maxBytes: number,
  path: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const cl = res.headers.get("content-length");
  if (cl) {
    const declared = Number(cl);
    if (Number.isFinite(declared) && declared > maxBytes) {
      void res.body?.cancel().catch(() => {});
      throw new HttpRequestInvalidError(
        `response too large: ${declared} bytes exceeds max_response_bytes ${maxBytes}`,
        path,
      );
    }
  }
  const body = res.body;
  if (!body || typeof body.getReader !== "function") {
    const buf = Buffer.from(await awaitWithAbort(res.arrayBuffer(), signal));
    if (buf.byteLength > maxBytes) {
      throw new HttpRequestInvalidError(
        `response too large: exceeds max_response_bytes ${maxBytes}`,
        path,
      );
    }
    return buf;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await awaitWithAbort(reader.read(), signal, () => {
        void reader.cancel().catch(() => {});
      });
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          void reader.cancel().catch(() => {});
          throw new HttpRequestInvalidError(
            `response too large: exceeds max_response_bytes ${maxBytes}`,
            path,
          );
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export async function readBodyCapped(
  res: Response,
  maxBytes: number,
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  return (await readBodyBytesCapped(res, maxBytes, path, signal)).toString("utf8");
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

async function awaitWithAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  onAbort?: () => void,
): Promise<T> {
  if (!signal) return await operation;
  if (signal.aborted) {
    onAbort?.();
    throw abortError(signal);
  }
  let handleAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_, reject) => {
    handleAbort = () => {
      onAbort?.();
      reject(abortError(signal));
    };
    signal.addEventListener("abort", handleAbort, { once: true });
  });
  try {
    const result = await Promise.race([operation, aborted]);
    if (signal.aborted) throw abortError(signal);
    return result;
  } finally {
    if (handleAbort) signal.removeEventListener("abort", handleAbort);
  }
}
