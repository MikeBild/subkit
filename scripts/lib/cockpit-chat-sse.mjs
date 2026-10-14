export function installChatConversationCapture({ timeoutMs = 5000, maxBytes = 64 * 1024 } = {}) {
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    const request = args[0];
    const url = new URL(typeof request === "string" ? request : request.url, location.href);
    const method = (
      args[1]?.method ?? (request instanceof Request ? request.method : "GET")
    ).toUpperCase();
    const headers = new Headers(
      args[1]?.headers ?? (request instanceof Request ? request.headers : undefined),
    );
    const acceptsEventStream = headers.get("accept")?.toLowerCase().includes("text/event-stream");
    if (
      method !== "POST" ||
      url.origin !== location.origin ||
      url.pathname !== "/v1/conversations" ||
      !acceptsEventStream
    )
      return response;

    if (
      !response.body ||
      !response.headers?.get("content-type")?.toLowerCase().includes("text/event-stream")
    ) {
      await window.__subkitConversationCaptureFailure(
        "Conversation creation did not return an SSE stream",
      );
      return response;
    }

    const reader = response.clone().body.getReader();
    let timer;
    const cancelReader = () =>
      Promise.race([
        reader.cancel().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 250)),
      ]);
    try {
      const captured = await Promise.race([
        (async () => {
          const decoder = new TextDecoder();
          let buffer = "";
          let totalBytes = 0;
          let trailingCarriageReturn = false;
          while (true) {
            const { done, value } = await reader.read();
            totalBytes += value?.byteLength ?? 0;
            if (totalBytes > maxBytes)
              throw new Error("Conversation stream exceeded capture limit");
            buffer += `${trailingCarriageReturn ? "\r" : ""}${decoder.decode(value, { stream: !done })}`;
            trailingCarriageReturn = !done && buffer.endsWith("\r");
            if (trailingCarriageReturn) buffer = buffer.slice(0, -1);
            const frames = buffer.split(/(?:\r\n){2}|\n\n|\r\r/);
            buffer = frames.pop() ?? "";
            if (done && buffer) {
              frames.push(buffer);
              buffer = "";
            }
            for (const frame of frames) {
              const lines = frame.split(/\r\n|\r|\n/);
              if (!lines.some((line) => line.trimEnd() === "event: conversation_started")) continue;
              const data = lines
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart())
                .join("\n");
              const id = JSON.parse(data).conversation?.id;
              if (typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)) {
                await window.__subkitCaptureOwnedConversation({ id });
                return true;
              }
              return false;
            }
            if (done) return false;
          }
        })(),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
        }),
      ]);
      if (captured !== true) {
        await cancelReader();
        await window.__subkitConversationCaptureFailure(
          captured === null
            ? "Timed out before receiving conversation_started"
            : "Conversation stream ended before a valid conversation_started id was captured",
        );
      } else void reader.cancel().catch(() => {});
    } catch (error) {
      await cancelReader();
      await window.__subkitConversationCaptureFailure(String(error));
    } finally {
      clearTimeout(timer);
    }
    return response;
  };
}
