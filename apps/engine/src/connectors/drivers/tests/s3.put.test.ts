import { describe, expect, spyOn, test } from "bun:test";
import { logger } from "../../../logging/logger.ts";
import { _withEgressLookupForTests } from "../../egress-guard.ts";
import { executeS3Request, probeS3Connector } from "../s3.ts";
import {
  type CapturedRequest,
  keyedConfig,
  listXml,
  s3Connector,
  TENANT,
  unusedDb,
  withStrictS3,
} from "./s3-fixtures.ts";

type Params = Parameters<typeof executeS3Request>[0];
const MB = 1024 * 1024;

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

function storeResponder(sent: CapturedRequest): Response {
  const url = new URL(sent.url);
  if (sent.method === "POST" && url.searchParams.has("uploads"))
    return new Response(
      "<InitiateMultipartUploadResult><UploadId>up-1</UploadId></InitiateMultipartUploadResult>",
    );
  if (sent.method === "POST")
    return new Response(
      "<CompleteMultipartUploadResult><ETag>&#34;multi-etag&#34;</ETag></CompleteMultipartUploadResult>",
    );
  return new Response(null, {
    headers: { etag: `"part-${url.searchParams.get("partNumber") ?? "single"}"` },
  });
}

async function* chunks(parts: number[][]): AsyncIterable<Uint8Array> {
  for (const part of parts) yield new Uint8Array(part);
}

function silenceWarnings() {
  const warnings: Array<Record<string, unknown>> = [];
  const spy = spyOn(logger, "warn").mockImplementation((entry: unknown) => {
    warnings.push(entry as Record<string, unknown>);
  });
  return { warnings, restore: () => spy.mockRestore() };
}

describe("s3 PUT bodies", () => {
  test("PUT with an undefined body is refused before any request", async () => {
    const { result, requests } = await withStrictS3(storeResponder, () =>
      request("PUT", "a.txt").catch((error: unknown) => error),
    );
    expect(requests).toHaveLength(0);
    expect((result as Error).message).toBe("s3 PUT requires a body");
  });

  test("a Uint8Array body is sent as the same bytes", async () => {
    const { requests } = await withStrictS3(storeResponder, () =>
      request("PUT", "u.bin", { body: new Uint8Array([9, 8, 7]) }),
    );
    expect([...(requests[0]?.body ?? [])]).toEqual([9, 8, 7]);
  });

  test("an async iterable body is streamed in order and the missing part-size hint is logged", async () => {
    const log = silenceWarnings();
    try {
      const { result, requests } = await withStrictS3(storeResponder, () =>
        request("PUT", "s.bin", { body: chunks([[1, 2], [], [3]]) }),
      );
      expect(requests).toHaveLength(1);
      expect([...(requests[0]?.body ?? [])]).toEqual([1, 2, 3]);
      expect((result.body as { multipart: unknown }).multipart).toBeNull();
      expect(
        log.warnings.filter((entry) => entry.action === "s3.put.unbounded_stream"),
      ).toHaveLength(1);
    } finally {
      log.restore();
    }
  });

  test("an async iterable body with a part-size hint logs no warning", async () => {
    const log = silenceWarnings();
    try {
      await withStrictS3(storeResponder, () =>
        request("PUT", "s.bin", { body: chunks([[1]]), multipartThresholdMb: 5 }),
      );
      expect(
        log.warnings.filter((entry) => entry.action === "s3.put.unbounded_stream"),
      ).toHaveLength(0);
    } finally {
      log.restore();
    }
  });

  test("a sync body never logs the unbounded stream warning", async () => {
    const log = silenceWarnings();
    try {
      await withStrictS3(storeResponder, () => request("PUT", "s.txt", { body: "x" }));
      expect(
        log.warnings.filter((entry) => entry.action === "s3.put.unbounded_stream"),
      ).toHaveLength(0);
    } finally {
      log.restore();
    }
  });

  test("an async iterable that fails aborts the upload with its error", async () => {
    async function* failing(): AsyncIterable<Uint8Array> {
      yield new Uint8Array([1]);
      throw new Error("source broke");
    }
    const log = silenceWarnings();
    try {
      const { result } = await withStrictS3(storeResponder, () =>
        request("PUT", "f.bin", { body: failing() }).catch((error: unknown) => error),
      );
      expect((result as Error).message).toBe("source broke");
    } finally {
      log.restore();
    }
  });

  test("a content type without metadata is sent as the object's content type", async () => {
    const { result, requests } = await withStrictS3(storeResponder, () =>
      request("PUT", "c.json", { body: "{}", contentType: "application/json" }),
    );
    expect(requests[0]?.headers.get("content-type")).toBe("application/json");
    expect(result.headers).toEqual({
      etag: "part-single",
      "x-amz-version-id": "",
      "content-type": "application/json",
    });
  });

  test("metadata without a content type sends no content type header", async () => {
    const { result, requests } = await withStrictS3(storeResponder, () =>
      request("PUT", "m.txt", { body: "m", metadata: { team: "ops" } }),
    );
    expect(requests[0]?.headers.get("x-amz-meta-team")).toBe("ops");
    expect(requests[0]?.headers.get("content-type")).not.toBe("undefined");
    expect("content-type" in result.headers).toBe(false);
  });
});

describe("s3 PUT part sizing", () => {
  const big = "a".repeat(6 * MB);

  test("a body above the part-size threshold is uploaded in parts", async () => {
    const { result, requests } = await withStrictS3(storeResponder, () =>
      request("PUT", "big.txt", { body: big, multipartThresholdMb: 5 }),
    );
    expect(requests.map((sent) => sent.method)).toEqual(["POST", "PUT", "PUT", "POST"]);
    expect(requests[1]?.body?.byteLength).toBe(5 * MB);
    expect(requests[2]?.body?.byteLength).toBe(MB);
    expect(result.body).toEqual({
      etag: "multi-etag",
      version_id: null,
      key: "big.txt",
      multipart: true,
    });
  });

  test("multipart false keeps a body above the threshold in a single request", async () => {
    const { result, requests } = await withStrictS3(storeResponder, () =>
      request("PUT", "big.txt", { body: big, multipart: false, multipartThresholdMb: 5 }),
    );
    expect(requests.map((sent) => sent.method)).toEqual(["PUT"]);
    expect(requests[0]?.body?.byteLength).toBe(6 * MB);
    expect((result.body as { multipart: boolean }).multipart).toBe(false);
  });

  test("a body exactly at the threshold is uploaded in parts", async () => {
    const { result } = await withStrictS3(storeResponder, () =>
      request("PUT", "edge.txt", { body: "a".repeat(5 * MB), multipartThresholdMb: 5 }),
    );
    expect((result.body as { multipart: boolean }).multipart).toBe(true);
  });

  test("a small body without hints is a single request and not multipart", async () => {
    const { result, requests } = await withStrictS3(storeResponder, () =>
      request("PUT", "small.txt", { body: "tiny" }),
    );
    expect(requests).toHaveLength(1);
    expect((result.body as { multipart: boolean }).multipart).toBe(false);
  });

  test("multipart false with a streamed body leaves the part size to the client", async () => {
    const log = silenceWarnings();
    try {
      const { result } = await withStrictS3(storeResponder, () =>
        request("PUT", "s.bin", { body: chunks([[1]]), multipart: false }),
      );
      expect((result.body as { multipart: unknown }).multipart).toBeNull();
    } finally {
      log.restore();
    }
  });
});

describe("s3 client configuration", () => {
  test("the default region signs for us-east-1 and an explicit region is honoured", async () => {
    const { requests } = await withStrictS3(
      () => listXml([]),
      async () => {
        await request("LIST", "/");
        await request("LIST", "/", {
          connector: s3Connector({ ...keyedConfig, region: "eu-central-1" }),
        });
      },
    );
    expect(requests[0]?.headers.get("authorization")).toContain("/us-east-1/s3/aws4_request");
    expect(requests[1]?.headers.get("authorization")).toContain("/eu-central-1/s3/aws4_request");
  });

  test("an empty endpoint falls back to the regional AWS host", async () => {
    const hosts: string[] = [];
    const { requests } = await _withEgressLookupForTests(
      async (hostname) => {
        hosts.push(hostname);
        return [{ address: "93.184.216.34", family: 4 }];
      },
      () =>
        withStrictS3(
          () => listXml([]),
          () => request("LIST", "/", { connector: s3Connector({ ...keyedConfig, endpoint: "" }) }),
        ),
    );
    expect(hosts).toContain("s3.us-east-1.amazonaws.com");
    expect(requests[0]?.headers.get("host")).toBe("s3.us-east-1.amazonaws.com");
  });

  test("config keys that are not strings leave the request unsigned", async () => {
    const { requests } = await withStrictS3(
      () => listXml([]),
      () =>
        request("LIST", "/", {
          connector: s3Connector({ access_key_id: 7, secret_access_key: "s" }),
        }),
    );
    expect(requests[0]?.headers.get("authorization")).toBeNull();
  });

  test("a secret that is not a string leaves the request unsigned", async () => {
    const { requests } = await withStrictS3(
      () => listXml([]),
      () =>
        request("LIST", "/", {
          connector: s3Connector({ access_key_id: "AKID", secret_access_key: 7 }),
        }),
    );
    expect(requests[0]?.headers.get("authorization")).toBeNull();
  });

  test("a non-string session token in config is not forwarded", async () => {
    const { requests } = await withStrictS3(
      () => listXml([]),
      () => request("LIST", "/", { connector: s3Connector({ ...keyedConfig, session_token: 5 }) }),
    );
    expect(requests[0]?.headers.get("x-amz-security-token")).toBeNull();
  });

  test("lower-case header credential names sign the request and carry the session token", async () => {
    const { requests } = await withStrictS3(
      () => listXml([]),
      () =>
        request("LIST", "/", {
          connector: s3Connector({}, { auth_type: "header" }),
          credential_override: {
            mode: "header",
            headers: {
              "x-access-key-id": "AKIDLOWER",
              "x-secret-access-key": "lower-secret",
              "x-session-token": "lower-session",
            },
          },
        }),
    );
    expect(requests[0]?.headers.get("authorization")).toContain("Credential=AKIDLOWER/");
    expect(requests[0]?.headers.get("x-amz-security-token")).toBe("lower-session");
  });

  test("a header credential without a session token sends none", async () => {
    const { requests } = await withStrictS3(
      () => listXml([]),
      () =>
        request("LIST", "/", {
          connector: s3Connector({}, { auth_type: "header" }),
          credential_override: {
            mode: "header",
            headers: { "X-Access-Key-Id": "AKID", "X-Secret-Access-Key": "s" },
          },
        }),
    );
    expect(requests[0]?.headers.get("x-amz-security-token")).toBeNull();
  });

  test("a presigned URL carries the session token", async () => {
    const { result } = await withStrictS3(
      () => listXml([]),
      () =>
        request("GET", "k", {
          connector: s3Connector({ ...keyedConfig, session_token: "presign-session" }),
          presignExpiresIn: 60,
        }),
    );
    const url = new URL((result.body as { url: string }).url);
    expect(url.searchParams.get("X-Amz-Security-Token")).toBe("presign-session");
  });

  test("a plain GET is signed in the Authorization header, not with a presigned URL", async () => {
    const { requests } = await withStrictS3(
      () => new Response("x", { headers: { "content-type": "text/plain" } }),
      () => request("GET", "plain.txt"),
    );
    expect(requests[0]?.headers.get("authorization")).toStartWith("AWS4-HMAC-SHA256");
    expect(requests[0]?.headers.get("range")).toBeNull();
    expect(new URL(requests[0]?.url ?? "").searchParams.has("X-Amz-Signature")).toBe(false);
  });
});

describe("s3 dispatch-bound listing", () => {
  test("a bound LIST hands the credential identity and snapshot to before_dispatch", async () => {
    const seen: unknown[] = [];
    await withStrictS3(
      () => listXml(["a"]),
      () =>
        request("LIST", "/", {
          connector: s3Connector({}, { auth_type: "aws_sigv4" }),
          credential_override: {
            mode: "aws_sigv4",
            access_key_id: "AKIDB",
            secret_access_key: "b",
          },
          before_dispatch: async (credential) => {
            seen.push(credential);
            return undefined;
          },
        }),
    );
    expect(seen[0]).toMatchObject({
      credential_id: null,
      credential_revision: null,
      connection_authority: null,
      credential_snapshot: {
        connector_id: "00000000-0000-4000-8000-0000000000b1",
        environment: "dev",
      },
    });
  });

  test("probe latency is measured from the start of the probe", async () => {
    const { result: ok } = await withStrictS3(
      () => listXml([]),
      () =>
        probeS3Connector({ db: unusedDb, tenant_id: TENANT, connector: s3Connector(keyedConfig) }),
    );
    const { result: failed } = await withStrictS3(
      () => new Response(null, { status: 500 }),
      () =>
        probeS3Connector({ db: unusedDb, tenant_id: TENANT, connector: s3Connector(keyedConfig) }),
    );
    for (const res of [ok, failed]) {
      expect(res.latency_ms).toBeGreaterThanOrEqual(0);
      expect(res.latency_ms).toBeLessThan(60_000);
    }
  });
});
