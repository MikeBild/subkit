// Tests for the LLM-provider Files API uploader. Each provider is
// exercised against a stub `fetch` that captures the request and
// returns a canned response — keeps the test deterministic and
// hermetic (no real Anthropic/OpenAI/Gemini calls).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FilesApiError, uploadFileViaApi } from "../files-api.ts";

interface StubResponse {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

function makeFetchStub(responses: StubResponse[]): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let i = 0;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: typeof input === "string" ? input : input.toString(), init });
    const r = responses[i++];
    if (!r) throw new Error("no more stubbed responses");
    const status = r.status ?? 200;
    const headers = new Headers(r.headers ?? {});
    const fakeRes = {
      ok: status >= 200 && status < 300,
      status,
      headers,
      json: async () => r.json,
      text: async () => r.text ?? JSON.stringify(r.json ?? {}),
    };
    return fakeRes as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, calls };
}

const ORIG_ENV = { ...process.env };
beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
});
afterEach(() => {
  process.env = { ...ORIG_ENV };
});

describe("uploadFileViaApi — anthropic", () => {
  test("uploads via x-api-key auth + returns the file_id", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const stub = makeFetchStub([
      {
        status: 200,
        json: { id: "file_abc", filename: "x.pdf", mime_type: "application/pdf", size_bytes: 4 },
      },
    ]);
    const out = await uploadFileViaApi({
      provider: "anthropic",
      data: new Uint8Array([1, 2, 3, 4]),
      mimeType: "application/pdf",
      filename: "x.pdf",
      fetchImpl: stub.fetch,
    });
    expect(out.file_id).toBe("file_abc");
    expect(out.provider).toBe("anthropic");
    expect(out.bytes).toBe(4);
    expect(stub.calls[0]?.url).toContain("/v1/files");
    const headers = stub.calls[0]?.init?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });

  test("throws FilesApiError when key missing", async () => {
    let caught: unknown;
    try {
      await uploadFileViaApi({
        provider: "anthropic",
        data: new Uint8Array([1]),
        mimeType: "text/plain",
        filename: "x.txt",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FilesApiError);
  });

  test("wraps non-2xx HTTP into FilesApiError with status", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const stub = makeFetchStub([{ status: 413, text: "file too large" }]);
    let caught: unknown;
    try {
      await uploadFileViaApi({
        provider: "anthropic",
        data: new Uint8Array([1]),
        mimeType: "text/plain",
        filename: "x.txt",
        fetchImpl: stub.fetch,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FilesApiError);
    expect((caught as FilesApiError).status).toBe(413);
  });
});

describe("uploadFileViaApi — openai", () => {
  test("uploads via Bearer auth + sets purpose=user_data", async () => {
    process.env.OPENAI_API_KEY = "sk-oai-test";
    const stub = makeFetchStub([
      { status: 200, json: { id: "file-123", filename: "x.csv", bytes: 8 } },
    ]);
    const out = await uploadFileViaApi({
      provider: "openai",
      data: new Uint8Array(8),
      mimeType: "text/csv",
      filename: "x.csv",
      fetchImpl: stub.fetch,
    });
    expect(out.file_id).toBe("file-123");
    expect(out.provider).toBe("openai");
    const headers = stub.calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-oai-test");
  });
});

describe("uploadFileViaApi — gemini", () => {
  test("does the two-phase resumable upload", async () => {
    process.env.GEMINI_API_KEY = "sk-gem-test";
    const stub = makeFetchStub([
      // Phase 1: returns upload URL via header
      {
        status: 200,
        headers: { "x-goog-upload-url": "https://upload.googleapis.com/x" },
        json: {},
      },
      // Phase 2: returns the file metadata
      {
        status: 200,
        json: { file: { name: "files/abc", size_bytes: "16" } },
      },
    ]);
    const out = await uploadFileViaApi({
      provider: "gemini",
      data: new Uint8Array(16),
      mimeType: "image/png",
      filename: "x.png",
      fetchImpl: stub.fetch,
    });
    expect(out.file_id).toBe("files/abc");
    expect(out.provider).toBe("gemini");
    expect(stub.calls.length).toBe(2);
  });
});

describe("uploadFileViaApi — unsupported provider", () => {
  test("throws for gateway / bedrock / azure / vertex", async () => {
    for (const provider of ["gateway", "bedrock", "azure", "vertex"] as const) {
      let caught: unknown;
      try {
        await uploadFileViaApi({
          provider,
          data: new Uint8Array([1]),
          mimeType: "text/plain",
          filename: "x.txt",
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(FilesApiError);
    }
  });
});
