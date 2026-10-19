import { expect, mock, test } from "bun:test";
import { runWithTestEnv } from "../../test-helpers/determinism/env.ts";
import type { ConnectorView } from "../types.ts";
import { _withDriverFetchForTests } from "./fetch-seam.ts";
import { buildS3Client } from "./s3.ts";

test("strict unbound S3 checks endpoint before credential use or SDK request", async () => {
  await runWithTestEnv({ NODE_ENV: "production" }, async () => {
    let credentialUsed = false;
    const client = buildS3Client({
      connector: {
        id: "s3-fixture",
        tenant_id: "s3-fixture",
        config: { endpoint: "http://127.0.0.1:9000", bucket: "fixture" },
      } as unknown as ConnectorView,
      on_credential_use: async () => {
        credentialUsed = true;
      },
    });
    await expect(client.makeRequest({ method: "GET", objectName: "fixture" })).rejects.toThrow(
      "private_ip_blocked",
    );
    expect(credentialUsed).toBe(false);
  });
});

test("strict signed S3 transport sends binary payload through manual guarded fetch", async () => {
  let captured: { url: string; request: RequestInit } | undefined;
  const fetchImpl = mock(async (url: string | URL | Request, request?: RequestInit) => {
    captured = { url: String(url), request: request ?? {} };
    return new Response(null);
  });
  await runWithTestEnv({ NODE_ENV: "production" }, () =>
    _withDriverFetchForTests(fetchImpl as unknown as typeof fetch, async () => {
      const client = buildS3Client({
        connector: {
          id: "s3-fixture",
          tenant_id: "s3-fixture",
          config: { endpoint: "https://93.184.216.34", bucket: "fixture" },
        } as unknown as ConnectorView,
        credentials: { access_key_id: "fixture", secret_access_key: "fixture" },
      });
      await client.makeRequest({
        method: "PUT",
        objectName: "space + percent%.txt",
        payload: new Uint8Array([97, 98, 99]),
        query: { partNumber: "1", uploadId: "fixture" },
      });
    }),
  );
  expect(captured?.url).toBe(
    "https://93.184.216.34/fixture/space%20%2B%20percent%25.txt?partNumber=1&uploadId=fixture",
  );
  expect(captured?.request.redirect).toBe("manual");
  const headers = new Headers(captured?.request.headers);
  expect(headers.get("authorization")).toContain("AWS4-HMAC-SHA256 Credential=fixture/");
  expect(headers.get("x-amz-content-sha256")).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  expect(headers.get("content-length")).toBe("3");
  expect(new Uint8Array(captured?.request.body as ArrayBuffer)).toEqual(
    new Uint8Array([97, 98, 99]),
  );
});

test("strict S3 rejects redirect without allowing SDK follow-up request", async () => {
  const fetchImpl = mock(
    async () =>
      new Response(null, {
        status: 307,
        headers: { location: "https://127.0.0.1/private" },
      }),
  );
  await runWithTestEnv({ NODE_ENV: "production" }, () =>
    _withDriverFetchForTests(fetchImpl as unknown as typeof fetch, async () => {
      const client = buildS3Client({
        connector: {
          id: "s3-fixture",
          tenant_id: "s3-fixture",
          config: { endpoint: "https://93.184.216.34", bucket: "fixture" },
        } as unknown as ConnectorView,
      });
      await expect(client.makeRequest({ method: "GET", objectName: "fixture" })).rejects.toThrow(
        "requires separate authorization",
      );
    }),
  );
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test("strict unbound virtual-host S3 checks the bucket endpoint", async () => {
  await runWithTestEnv({ NODE_ENV: "production" }, async () => {
    const client = buildS3Client({
      connector: {
        id: "s3-fixture",
        tenant_id: "s3-fixture",
        config: {
          endpoint: "https://storage.internal",
          bucket: "fixture",
          force_path_style: false,
        },
      } as unknown as ConnectorView,
    });
    await expect(client.makeRequest({ method: "GET", objectName: "fixture" })).rejects.toThrow(
      "private_ip_blocked",
    );
  });
});
