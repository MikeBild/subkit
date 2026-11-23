export type AcceptedOperations =
  | { ok: true; indices: number[] | undefined }
  | { ok: false; message: string };

export function parseAcceptedOperations(raw: string | undefined): AcceptedOperations {
  if (raw === undefined) return { ok: true, indices: undefined };
  const parts = raw.split(",").map((part) => part.trim());
  if (parts.some((part) => !/^\d+$/.test(part)))
    return {
      ok: false,
      message:
        "--accept takes zero-based change numbers separated by commas, for example --accept 0,2",
    };
  const indices = [...new Set(parts.map(Number))].sort((a, b) => a - b);
  if (indices.some((index) => !Number.isSafeInteger(index)))
    return { ok: false, message: "--accept got a change number that is too large" };
  return { ok: true, indices };
}
