export type MessageResponse = { ok: true; value?: unknown } | { ok: false; error: string };

export type SendResponse = (response: MessageResponse) => void;

export function respondWith(result: Promise<unknown>, sendResponse: SendResponse): true {
  result.then(
    (value) => sendResponse({ ok: true, value }),
    (error: unknown) =>
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return true;
}

function isMessageResponse(raw: unknown): raw is MessageResponse {
  if (!raw || typeof raw !== "object" || typeof (raw as { ok?: unknown }).ok !== "boolean") {
    return false;
  }
  const keys = Object.keys(raw);
  return keys.every((key) => key === "ok" || key === "value" || key === "error");
}

export function unwrapResponse<Value = unknown>(raw: unknown): Value {
  if (!isMessageResponse(raw)) return raw as Value;
  if (!raw.ok) throw new Error(raw.error);
  return raw.value as Value;
}
