const PROVIDER_HOSTS = new Set([
  "api.anthropic.com",
  "api.openai.com",
  "generativelanguage.googleapis.com",
]);

export interface ProviderCall {
  url: string;
  headers: Record<string, string>;
}

export function anthropicAnswer(model = "claude-haiku-4-5"): Response {
  return Response.json({
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: "OK" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 1 },
  });
}

export function anthropicRefusal(status: number, type: string): Response {
  return Response.json(
    { type: "error", error: { type, message: "provider fixture refusal" } },
    { status },
  );
}

export function stubProviderHttp(respond: (call: ProviderCall) => Response | Promise<Response>): {
  calls: ProviderCall[];
  restore(): void;
} {
  const original = globalThis.fetch;
  const calls: ProviderCall[] = [];
  const stubbed = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (!PROVIDER_HOSTS.has(new URL(request.url).hostname)) return original(input, init);
    const call = { url: request.url, headers: Object.fromEntries(request.headers.entries()) };
    calls.push(call);
    return respond(call);
  };
  globalThis.fetch = Object.assign(stubbed, original) as typeof fetch; // global-fetch-allowed: HTTP-level tests reach the provider from the server's own request context; only the three provider hosts are intercepted and restore() puts the original back
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

export async function captureProcessOutput(run: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const grab = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  };
  process.stdout.write = grab as typeof process.stdout.write;
  process.stderr.write = grab as typeof process.stderr.write;
  try {
    await run();
  } finally {
    process.stdout.write = out as typeof process.stdout.write;
    process.stderr.write = err as typeof process.stderr.write;
  }
  return chunks.join("");
}
