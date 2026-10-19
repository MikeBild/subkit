import { PageTooLargeError, PER_PAGE_BYTES } from "./budgets.ts";

export async function readBoundedText(
  response: Response,
  maxBytes = PER_PAGE_BYTES,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new Error("invalid_document_page_limit");
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && BigInt(declared) > BigInt(maxBytes)) {
    await response.body?.cancel().catch(() => {});
    throw new PageTooLargeError(maxBytes + 1);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new PageTooLargeError(bytes);
      chunks.push(value);
    }
    const text = new TextDecoder().decode(Buffer.concat(chunks, bytes));
    const decodedBytes = Buffer.byteLength(text, "utf8");
    if (decodedBytes > maxBytes) throw new PageTooLargeError(decodedBytes);
    return text;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
