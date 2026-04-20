// /v1/extract — file-format matrix against docs/04-authoring.md.
//
// The endpoint accepts a raw body and detects the format from the
// content-type header. This suite covers the happy path for each
// supported format and the 415 path for an unsupported one
// (application/pdf).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;

beforeAll(async () => {
  srv = await createHttpTestServer("extract-formats");
});

afterAll(async () => {
  await srv.cleanup();
});

function authHeaders(contentType: string): HeadersInit {
  return {
    authorization: `Bearer ${srv.apiKey}`,
    "content-type": contentType,
  };
}

describe("/v1/extract file-format matrix", () => {
  test("JSON body → 200 + parsed data", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/extract`, {
      method: "POST",
      headers: authHeaders("application/json"),
      body: JSON.stringify({ hello: "world", n: 42 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { format: string; data: Record<string, unknown> };
    expect(body.format).toBe("json");
    expect(body.data.hello).toBe("world");
    expect(body.data.n).toBe(42);
  });

  test("CSV body → 200 + parsed rows", async () => {
    const csv = "id,name\n1,alice\n2,bob\n";
    const res = await fetch(`${srv.baseUrl}/v1/extract`, {
      method: "POST",
      headers: authHeaders("text/csv"),
      body: csv,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { format: string; data: Array<Record<string, string>> };
    expect(body.format).toBe("csv");
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(2);
    expect(body.data[0]?.id).toBe("1");
    expect(body.data[0]?.name).toBe("alice");
    expect(body.data[1]?.name).toBe("bob");
  });

  test("YAML body → 200 + parsed keys", async () => {
    const yaml = "title: demo\ncount: 3\n";
    const res = await fetch(`${srv.baseUrl}/v1/extract`, {
      method: "POST",
      headers: authHeaders("application/yaml"),
      body: yaml,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { format: string; data: Record<string, unknown> };
    expect(body.format).toBe("yaml");
    expect(body.data.title).toBe("demo");
    expect(body.data.count).toBe(3);
  });

  test("XML body → 200 + parsed tree", async () => {
    const xml = `<?xml version="1.0"?><root><item id="1">alpha</item><item id="2">beta</item></root>`;
    const res = await fetch(`${srv.baseUrl}/v1/extract`, {
      method: "POST",
      headers: authHeaders("application/xml"),
      body: xml,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      format: string;
      data: { children: Array<{ name: string }> };
    };
    expect(body.format).toBe("xml");
    expect(body.data.children[0]?.name).toBe("root");
  });

  test("PDF body → 415 + unsupported_file_format", async () => {
    // A minimal PDF magic-byte prefix is enough — the detector only
    // looks at the mime type here.
    const res = await fetch(`${srv.baseUrl}/v1/extract`, {
      method: "POST",
      headers: authHeaders("application/pdf"),
      body: "%PDF-1.4\n%fake\n",
    });
    expect(res.status).toBe(415);
    const body = (await res.json()) as { code: string; details?: { supported?: string[] } };
    expect(body.code).toBe("unsupported_file_format");
    expect(body.details?.supported).toContain("json");
    expect(body.details?.supported).toContain("csv");
  });
});
