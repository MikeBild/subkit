export interface SSEFrame {
  id?: string;
  event?: string;
  data?: string;
}

function parseFrame(raw: string): SSEFrame {
  const frame: SSEFrame = {};
  for (const line of raw.split("\n")) {
    if (line.startsWith("id:")) frame.id = line.slice(3).trim();
    else if (line.startsWith("event:")) frame.event = line.slice(6).trim();
    else if (line.startsWith("data:")) frame.data = line.slice(5).trim();
  }
  return frame;
}

export async function collectFrames(
  res: Response,
  until: (frames: SSEFrame[]) => boolean,
  timeoutMs: number = 10_000,
): Promise<{ frames: SSEFrame[]; serverClosed: boolean }> {
  if (!res.body) throw new Error("SSE response has no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frames: SSEFrame[] = [];
  let buffer = "";
  let serverClosed = false;
  // allow-wall-clock: a live SSE stream is read against a real deadline.
  const deadline = Date.now() + timeoutMs;
  const remaining = () => deadline - Date.now() + 50; // allow-wall-clock: read budget
  try {
    // allow-wall-clock: bounded read loop against a live SSE stream.
    while (Date.now() < deadline) {
      if (until(frames)) break;
      const timer = new Promise<{ done: true; value: undefined }>((resolve) =>
        // allow-wall-clock: a silent server must not stall the journey.
        setTimeout(() => resolve({ done: true, value: undefined }), remaining()),
      );
      const chunk = (await Promise.race([reader.read(), timer])) as {
        done?: boolean;
        value?: Uint8Array;
      };
      if (!chunk || chunk.done || !chunk.value) {
        serverClosed = Boolean(chunk?.done && chunk.value === undefined);
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const frame = parseFrame(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
        if (frame.id || frame.event || frame.data) frames.push(frame);
        idx = buffer.indexOf("\n\n");
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }
  return { frames, serverClosed };
}

export async function collectFrameList(
  res: Response,
  until: (frames: SSEFrame[]) => boolean,
  timeoutMs?: number,
): Promise<SSEFrame[]> {
  return (await collectFrames(res, until, timeoutMs)).frames;
}
