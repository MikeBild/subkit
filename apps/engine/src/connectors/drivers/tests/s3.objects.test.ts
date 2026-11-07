import { describe, expect, test } from "bun:test";
import { executeS3Request, probeS3Connector } from "../s3.ts";
import {
  keyedConfig,
  listXml,
  s3Connector,
  TENANT,
  unusedDb,
  withStrictS3,
} from "./s3-fixtures.ts";

type Params = Parameters<typeof executeS3Request>[0];

function request(method: Params["method"], path: string, extra: Partial<Params> = {}) {
  return executeS3Request({
    db: unusedDb,
    tenant_id: TENANT,
    connector: s3Connector(keyedConfig),
    method,
    path,
    ...extra,
  });
}

describe("s3 GET", () => {
  test("a text object is returned as a utf-8 string with its headers", async () => {
    const { result, requests } = await withStrictS3(
      () => new Response("a,b\n1,2", { headers: { "content-type": "text/csv" } }),
      () => request("GET", "/data/report.csv"),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/fixture/data/report.csv");
    expect(result.status).toBe(200);
    expect(result.body).toBe("a,b\n1,2");
    expect(result.headers["content-type"]).toBe("text/csv");
  });

  test.each([["application/json"], ["application/xml"], ["application/yaml"], ["TEXT/PLAIN"]])(
    "content type %s is treated as text",
    async (contentType) => {
      const { result } = await withStrictS3(
        () => new Response("{}", { headers: { "content-type": contentType } }),
        () => request("GET", "doc"),
      );
      expect(result.body).toBe("{}");
    },
  );

  test("a binary object is returned as a Buffer with the exact bytes", async () => {
    const { result } = await withStrictS3(
      () =>
        new Response(new Uint8Array([0, 255, 7]), {
          headers: { "content-type": "application/octet-stream" },
        }),
      () => request("GET", "blob.bin"),
    );
    expect(Buffer.isBuffer(result.body)).toBe(true);
    expect([...(result.body as Buffer)]).toEqual([0, 255, 7]);
  });

  test("an object without a content type is returned as bytes", async () => {
    const { result } = await withStrictS3(
      () => new Response(new Uint8Array([104, 105])),
      () => request("GET", "unknown"),
    );
    expect(Buffer.isBuffer(result.body)).toBe(true);
  });

  test("a range read sends the Range header to a signed URL for the object", async () => {
    const used: unknown[] = [];
    const { result, requests } = await withStrictS3(
      () => new Response("ab", { status: 206, headers: { "content-type": "text/plain" } }),
      () =>
        request("GET", "big.txt", {
          range: "bytes=0-1",
          on_credential_use: async (snapshot) => {
            used.push(snapshot);
          },
        }),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("range")).toBe("bytes=0-1");
    const url = new URL(requests[0]?.url ?? "");
    expect(url.pathname).toBe("/fixture/big.txt");
    expect(url.searchParams.get("X-Amz-Credential")).toStartWith("AKIDFIXTURE/");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(used).toHaveLength(1);
    expect(result.status).toBe(206);
    expect(result.body).toBe("ab");
  });

  test("a range read to a private endpoint is refused in strict mode before any request", async () => {
    const used: unknown[] = [];
    const { result, requests } = await withStrictS3(
      () => new Response("secret", { status: 206 }),
      () =>
        request("GET", "big.txt", {
          connector: s3Connector({ ...keyedConfig, endpoint: "http://10.0.0.5:9000" }),
          range: "bytes=0-1",
          on_credential_use: async (snapshot) => {
            used.push(snapshot);
          },
        }).catch((error: unknown) => error),
    );
    expect(requests).toHaveLength(0);
    expect(used).toHaveLength(0);
    expect((result as Error).message).toContain("private_ip_blocked");
  });

  test("a presigned GET returns a signed URL without contacting the store", async () => {
    const { result, requests } = await withStrictS3(
      () => new Response("unexpected"),
      () => request("GET", "share/me.pdf", { presignExpiresIn: 300 }),
    );
    expect(requests).toHaveLength(0);
    const body = result.body as { url: string; method: string; expires_at: string };
    const url = new URL(body.url);
    expect(url.pathname).toBe("/fixture/share/me.pdf");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(body.method).toBe("GET");
    expect(Number.isNaN(Date.parse(body.expires_at))).toBe(false);
    expect(result.headers).toEqual({ "content-type": "application/json" });
  });
});

describe("s3 PUT", () => {
  test("PUT without a body is refused before any request", async () => {
    const { result, requests } = await withStrictS3(
      () => new Response(null),
      () => request("PUT", "a.txt", { body: null }).catch((error: unknown) => error),
    );
    expect(requests).toHaveLength(0);
    expect((result as Error).message).toBe("s3 PUT requires a body");
  });

  test("PUT sends the payload with content type and lower-cased metadata headers", async () => {
    const { result, requests } = await withStrictS3(
      () => new Response(null, { headers: { etag: '"etag-1"', "x-amz-version-id": "v7" } }),
      () =>
        request("PUT", "/docs/a.json", {
          body: '{"a":1}',
          contentType: "application/json",
          metadata: { Owner: "ops" },
        }),
    );
    expect(requests).toHaveLength(1);
    const sent = requests[0];
    expect(sent?.method).toBe("PUT");
    expect(new URL(sent?.url ?? "").pathname).toBe("/fixture/docs/a.json");
    expect(sent?.headers.get("content-type")).toBe("application/json");
    expect(sent?.headers.get("x-amz-meta-owner")).toBe("ops");
    expect(new TextDecoder().decode(sent?.body ?? new Uint8Array())).toBe('{"a":1}');
    expect(result).toEqual({
      status: 200,
      headers: { etag: "etag-1", "x-amz-version-id": "v7", "content-type": "application/json" },
      body: { etag: "etag-1", version_id: "v7", key: "docs/a.json", multipart: false },
      credential_id: null,
    });
  });

  test("PUT of a Buffer body sends the same bytes", async () => {
    const { requests } = await withStrictS3(
      () => new Response(null, { headers: { etag: '"e"' } }),
      () => request("PUT", "b.bin", { body: Buffer.from([1, 2, 3]) }),
    );
    expect([...(requests[0]?.body ?? [])]).toEqual([1, 2, 3]);
  });

  test("a presigned PUT returns a signed URL without contacting the store", async () => {
    const { result, requests } = await withStrictS3(
      () => new Response(null),
      () => request("PUT", "upload.bin", { body: "x", presignExpiresIn: 60 }),
    );
    expect(requests).toHaveLength(0);
    const body = result.body as { url: string; method: string };
    expect(body.method).toBe("PUT");
    expect(new URL(body.url).searchParams.get("X-Amz-Expires")).toBe("60");
  });
});

describe("s3 HEAD and DELETE", () => {
  test("HEAD of a missing object returns 404 without a body", async () => {
    const { result } = await withStrictS3(
      () => new Response(null, { status: 404 }),
      () => request("HEAD", "missing.txt"),
    );
    expect(result).toEqual({ status: 404, headers: {}, body: null, credential_id: null });
  });

  test("HEAD of an existing object returns its size and etag", async () => {
    const { result, requests } = await withStrictS3(
      () =>
        new Response(null, {
          headers: {
            "content-length": "42",
            etag: '"etag-h"',
            "last-modified": "Tue, 14 Nov 2023 22:13:20 GMT",
          },
        }),
      () => request("HEAD", "present.txt"),
    );
    expect(requests.every((sent) => sent.method === "HEAD")).toBe(true);
    expect(result).toEqual({
      status: 200,
      headers: { "content-length": "42", etag: "etag-h" },
      body: { key: "present.txt", size: 42, etag: "etag-h" },
      credential_id: null,
    });
  });

  test("HEAD surfaces a server failure other than 404", async () => {
    const { result } = await withStrictS3(
      () => new Response(null, { status: 500 }),
      () => request("HEAD", "x").catch((error: unknown) => error),
    );
    expect(result).toMatchObject({ statusCode: 500 });
  });

  test("DELETE removes one object and answers 204", async () => {
    const { result, requests } = await withStrictS3(
      () => new Response(null, { status: 204 }),
      () => request("DELETE", "/old/report.csv"),
    );
    expect(requests.map((sent) => sent.method)).toEqual(["DELETE"]);
    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/fixture/old/report.csv");
    expect(result).toEqual({ status: 204, headers: {}, body: null, credential_id: null });
  });

  test.each([["old/"], ["/"]])(
    "DELETE of the folder prefix %s is refused before any request",
    async (path) => {
      const { result, requests } = await withStrictS3(
        () => new Response(null, { status: 204 }),
        () => request("DELETE", path).catch((error: unknown) => error),
      );
      expect(requests).toHaveLength(0);
      expect((result as Error).message).toContain("folder prefix");
    },
  );

  test("DELETE with a body is refused before any request", async () => {
    const { result, requests } = await withStrictS3(
      () => new Response(null, { status: 204 }),
      () => request("DELETE", "a.txt", { body: "x" }).catch((error: unknown) => error),
    );
    expect(requests).toHaveLength(0);
    expect((result as Error).message).toContain("does not accept a body");
  });

  test("an unsupported method is refused", async () => {
    const { result, requests } = await withStrictS3(
      () => new Response(null),
      () => request("POST" as Params["method"], "a").catch((error: unknown) => error),
    );
    expect(requests).toHaveLength(0);
    expect((result as Error).message).toBe("s3 driver: unsupported method POST");
  });
});

describe("s3 probe", () => {
  test("a stored-credential connector without a credential reports credential_missing", async () => {
    const { result, requests } = await withStrictS3(
      () => listXml([]),
      () =>
        probeS3Connector({
          db: unusedDb,
          tenant_id: TENANT,
          connector: s3Connector({}, { auth_type: "aws_sigv4" }),
          credential_override: null,
        }),
    );
    expect(requests).toHaveLength(0);
    expect(result).toEqual({
      ok: false,
      latency_ms: 0,
      detail: "credential_required",
      error_code: "credential_missing",
    });
  });

  test("a successful listing reports ok with status 200", async () => {
    const { result, requests } = await withStrictS3(
      () => listXml(["a"]),
      () =>
        probeS3Connector({
          db: unusedDb,
          tenant_id: TENANT,
          connector: s3Connector({}, { auth_type: "aws_sigv4" }),
          credential_override: {
            mode: "aws_sigv4",
            access_key_id: "AKIDPROBE",
            secret_access_key: "probe-secret",
          },
        }),
    );
    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({ ok: true, status: 200 });
  });

  test.each([
    [403, "credential_invalid"],
    [404, "remote_resource_not_found"],
    [500, "unknown_upstream_error"],
  ])("a listing answered with %d is classified as %s", async (status, code) => {
    const { result } = await withStrictS3(
      () => new Response(null, { status }),
      () =>
        probeS3Connector({ db: unusedDb, tenant_id: TENANT, connector: s3Connector(keyedConfig) }),
    );
    expect(result).toMatchObject({ ok: false, error_code: code });
  });

  test("a bearer credential is reported as invalid without a request", async () => {
    const { result, requests } = await withStrictS3(
      () => listXml([]),
      () =>
        probeS3Connector({
          db: unusedDb,
          tenant_id: TENANT,
          connector: s3Connector({}, { auth_type: "bearer" }),
          credential_override: { mode: "bearer", token: "probe-token" },
        }),
    );
    expect(requests).toHaveLength(0);
    expect(result).toMatchObject({ ok: false, error_code: "credential_invalid" });
    expect(JSON.stringify(result)).not.toContain("probe-token");
  });
});
