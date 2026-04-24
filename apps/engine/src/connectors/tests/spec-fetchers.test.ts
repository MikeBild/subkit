import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { fetchGraphQLIntrospection, fetchOpenApiSpec, SpecFetchError } from "../spec-fetchers.ts";

describe("fetchOpenApiSpec — SSRF guard", () => {
  test("rejects localhost", async () => {
    await expect(fetchOpenApiSpec("http://localhost/openapi.json")).rejects.toThrow(SpecFetchError);
  });

  test("rejects 127.0.0.1", async () => {
    await expect(fetchOpenApiSpec("http://127.0.0.1/openapi.json")).rejects.toThrow(SpecFetchError);
  });

  test("rejects 10.x RFC-1918 address", async () => {
    await expect(fetchOpenApiSpec("http://10.0.0.1/openapi.json")).rejects.toThrow(SpecFetchError);
  });

  test("rejects 192.168.x address", async () => {
    await expect(fetchOpenApiSpec("http://192.168.1.1/openapi.json")).rejects.toThrow(
      SpecFetchError,
    );
  });

  test("rejects 169.254.169.254 (metadata endpoint)", async () => {
    await expect(fetchOpenApiSpec("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      SpecFetchError,
    );
  });

  test("SSRF error carries the blocked url", async () => {
    let caught: SpecFetchError | null = null;
    try {
      await fetchOpenApiSpec("http://localhost/openapi.json");
    } catch (e) {
      if (e instanceof SpecFetchError) caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught!.url).toBe("http://localhost/openapi.json");
    expect(caught!.status).toBeNull();
  });
});

describe("fetchOpenApiSpec — invalid URL", () => {
  test("throws on completely invalid URL", async () => {
    await expect(fetchOpenApiSpec("not-a-url")).rejects.toThrow();
  });
});

describe("fetchOpenApiSpec — size budget via mocked fetch", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test("rejects content larger than 8 MB", async () => {
    const bigBuffer = new ArrayBuffer(9 * 1024 * 1024); // 9 MB
    fetchSpy.mockResolvedValue(
      new Response(bigBuffer, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(fetchOpenApiSpec("https://external.api.example.com/openapi.json")).rejects.toThrow(
      SpecFetchError,
    );
  });

  test("accepts content within the 8 MB budget", async () => {
    const smallContent = JSON.stringify({ openapi: "3.0.0", paths: {} });
    const encoder = new TextEncoder();
    fetchSpy.mockResolvedValue(
      new Response(encoder.encode(smallContent), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await fetchOpenApiSpec("https://external.api.example.com/openapi.json");
    expect(result.content).toBe(smallContent);
    expect(result.fetched_from).toBe("https://external.api.example.com/openapi.json");
  });

  test("throws SpecFetchError on non-2xx response", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 404 }));
    await expect(fetchOpenApiSpec("https://external.api.example.com/missing.json")).rejects.toThrow(
      SpecFetchError,
    );
  });
});

describe("fetchGraphQLIntrospection — SSRF guard", () => {
  test("rejects private host", async () => {
    await expect(fetchGraphQLIntrospection("http://10.0.0.5/graphql")).rejects.toThrow(
      SpecFetchError,
    );
  });
});

describe("fetchGraphQLIntrospection — mocked fetch", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test("throws when response has no data field", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ message: "not found" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      fetchGraphQLIntrospection("https://external.api.example.com/graphql"),
    ).rejects.toThrow(SpecFetchError);
  });

  test("throws SpecFetchError on non-2xx status", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 500 }));
    await expect(
      fetchGraphQLIntrospection("https://external.api.example.com/graphql"),
    ).rejects.toThrow(SpecFetchError);
  });
});
