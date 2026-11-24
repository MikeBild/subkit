import { describe, expect, test } from "bun:test";
import { EngineClient } from "../engine-client.ts";

const clientCapturing = (calls: Array<RequestInit | undefined>) =>
  new EngineClient({
    engine_url: "https://engine.test",
    api_key: "key",
    fetchImpl: async (_input, init) => {
      calls.push(init);
      return Response.json({ format: "xlsx", bytes: 3, data: {} });
    },
  });

describe("EngineClient.extractFile", () => {
  test("sends a non-ASCII filename as an ASCII-safe x-filename header", async () => {
    const calls: Array<RequestInit | undefined> = [];
    const filename = "東京 予算.xlsx";
    await clientCapturing(calls).extractFile({
      buffer: new Uint8Array([1, 2, 3]),
      contentType: "application/octet-stream",
      filename,
    });
    expect(calls).toHaveLength(1);
    const header = new Headers(calls[0]?.headers).get("x-filename") ?? "";
    expect(header).toMatch(/^[\x20-\x7e]+$/);
    expect(header.endsWith(".xlsx")).toBe(true);
    expect(decodeURIComponent(header)).toBe(filename);
  });

  test("keeps a plain ASCII filename unchanged", async () => {
    const calls: Array<RequestInit | undefined> = [];
    await clientCapturing(calls).extractFile({
      buffer: new Uint8Array([1]),
      contentType: "application/pdf",
      filename: "report.pdf",
    });
    expect(new Headers(calls[0]?.headers).get("x-filename")).toBe("report.pdf");
  });
});
