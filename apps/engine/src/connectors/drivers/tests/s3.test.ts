import { describe, expect, test } from "bun:test";
import { _withEgressLookupForTests } from "../../egress-guard.ts";
import { executeS3Request, S3CredentialError } from "../s3.ts";
import {
  keyedConfig,
  listXml,
  s3Connector,
  TENANT,
  unusedDb,
  withStrictS3,
} from "./s3-fixtures.ts";

function list(
  connector: ReturnType<typeof s3Connector>,
  extra: Partial<Parameters<typeof executeS3Request>[0]> = {},
) {
  return executeS3Request({
    db: unusedDb,
    tenant_id: TENANT,
    connector,
    method: "LIST",
    path: "/",
    ...extra,
  });
}

function keys(count: number, prefix = "k"): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(5, "0")}`);
}

describe("s3 credential resolution", () => {
  test("auth_type none with keys in config signs the request with those keys", async () => {
    const { requests } = await withStrictS3(
      () => listXml([]),
      () => list(s3Connector(keyedConfig)),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("authorization")).toStartWith(
      "AWS4-HMAC-SHA256 Credential=AKIDFIXTURE/",
    );
    expect(requests[0]?.headers.get("x-amz-security-token")).toBeNull();
  });

  test("auth_type none forwards a configured session token", async () => {
    const { requests } = await withStrictS3(
      () => listXml([]),
      () => list(s3Connector({ ...keyedConfig, session_token: "session-fixture" })),
    );
    expect(requests[0]?.headers.get("x-amz-security-token")).toBe("session-fixture");
  });

  test("auth_type none with an empty access key id sends an unsigned request", async () => {
    const { result, requests } = await withStrictS3(
      () => listXml([]),
      () => list(s3Connector({ access_key_id: "", secret_access_key: "fixture-secret" })),
    );
    expect(requests[0]?.headers.get("authorization")).toBeNull();
    expect(result.credential_id).toBeNull();
  });

  test("a stored-credential connector without a credential is refused before any request", async () => {
    const { result, requests } = await withStrictS3(
      () => listXml([]),
      () =>
        list(s3Connector({}, { auth_type: "aws_sigv4" }), { credential_override: null }).catch(
          (error: unknown) => error,
        ),
    );
    expect(requests).toHaveLength(0);
    expect(result).toBeInstanceOf(S3CredentialError);
    expect((result as S3CredentialError).error_code).toBe("credential_missing");
    expect((result as S3CredentialError).message).toContain("fixture-bucket");
  });

  test("an aws_sigv4 credential signs with its keys and session token", async () => {
    const { result, requests } = await withStrictS3(
      () => listXml([]),
      () =>
        list(s3Connector({}, { auth_type: "aws_sigv4" }), {
          credential_override: {
            mode: "aws_sigv4",
            access_key_id: "AKIDSTORED",
            secret_access_key: "stored-secret",
            session_token: "stored-session",
          },
        }),
    );
    expect(requests[0]?.headers.get("authorization")).toStartWith(
      "AWS4-HMAC-SHA256 Credential=AKIDSTORED/",
    );
    expect(requests[0]?.headers.get("x-amz-security-token")).toBe("stored-session");
    expect(result.credential_id).toBeNull();
  });

  test("a header credential with access key headers signs the request", async () => {
    const { requests } = await withStrictS3(
      () => listXml([]),
      () =>
        list(s3Connector({}, { auth_type: "header" }), {
          credential_override: {
            mode: "header",
            headers: {
              "X-Access-Key-Id": "AKIDHEADER",
              "X-Secret-Access-Key": "header-secret",
              "X-Session-Token": "header-session",
            },
          },
        }),
    );
    expect(requests[0]?.headers.get("authorization")).toStartWith(
      "AWS4-HMAC-SHA256 Credential=AKIDHEADER/",
    );
    expect(requests[0]?.headers.get("x-amz-security-token")).toBe("header-session");
  });

  test("a header credential without the secret header is refused as invalid", async () => {
    const { result, requests } = await withStrictS3(
      () => listXml([]),
      () =>
        list(s3Connector({}, { auth_type: "header" }), {
          credential_override: { mode: "header", headers: { "x-access-key-id": "AKIDHEADER" } },
        }).catch((error: unknown) => error),
    );
    expect(requests).toHaveLength(0);
    expect((result as S3CredentialError).error_code).toBe("credential_invalid");
  });

  test("a bearer credential cannot sign s3 requests", async () => {
    const { result, requests } = await withStrictS3(
      () => listXml([]),
      () =>
        list(s3Connector({}, { auth_type: "bearer" }), {
          credential_override: { mode: "bearer", token: "fixture-token" },
        }).catch((error: unknown) => error),
    );
    expect(requests).toHaveLength(0);
    expect((result as S3CredentialError).error_code).toBe("credential_mode_unsupported_for_s3");
    expect((result as S3CredentialError).message).toContain('"bearer"');
    expect(JSON.stringify(result)).not.toContain("fixture-token");
  });

  test("a connector without a bucket is refused before any request", async () => {
    const { result, requests } = await withStrictS3(
      () => listXml([]),
      () => list(s3Connector({ bucket: "" })).catch((error: unknown) => error),
    );
    expect(requests).toHaveLength(0);
    expect((result as Error).message).toContain("missing config.bucket");
  });
});

describe("s3 LIST", () => {
  test("lists under the prefix without its leading slash and maps each object", async () => {
    const { result, requests } = await withStrictS3(
      () =>
        new Response(
          `<ListBucketResult><Contents><Key>reports/a.csv</Key><LastModified>2023-11-14T22:13:20.000Z</LastModified><ETag>"abc"</ETag><Size>7</Size></Contents><IsTruncated>false</IsTruncated></ListBucketResult>`,
        ),
      () => list(s3Connector(keyedConfig), { path: "/reports/" }),
    );
    const url = new URL(requests[0]?.url ?? "");
    expect(url.pathname).toBe("/fixture/");
    expect(url.searchParams.get("list-type")).toBe("2");
    expect(url.searchParams.get("prefix")).toBe("reports/");
    expect(result).toEqual({
      status: 200,
      headers: {},
      body: {
        items: [
          { key: "reports/a.csv", size: 7, etag: "abc", last_modified: "2023-11-14T22:13:20.000Z" },
        ],
        count: 1,
        truncated: false,
        paginated: false,
      },
      credential_id: null,
    });
  });

  test("virtual-host style puts the bucket into the host name", async () => {
    const { requests } = await _withEgressLookupForTests(
      async () => [{ address: "93.184.216.34", family: 4 }],
      () =>
        withStrictS3(
          () => listXml([]),
          () =>
            list(
              s3Connector({
                ...keyedConfig,
                endpoint: "https://storage.example.com",
                force_path_style: false,
              }),
            ),
        ),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("host")).toBe("fixture.storage.example.com");
    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/");
  });

  test("follows continuation tokens across pages", async () => {
    let page = 0;
    const { result, requests } = await withStrictS3(
      () => {
        page += 1;
        return page === 1
          ? listXml(["a", "b"], { truncated: true, next: "tok-2" })
          : listXml(["c"]);
      },
      () => list(s3Connector(keyedConfig), { maxKeys: 10 }),
    );
    expect(requests).toHaveLength(2);
    expect(new URL(requests[1]?.url ?? "").searchParams.get("continuation-token")).toBe("tok-2");
    const body = result.body as { items: Array<{ key: string }>; truncated: boolean };
    expect(body.items.map((item) => item.key)).toEqual(["a", "b", "c"]);
    expect(body.truncated).toBe(false);
  });

  test("maxKeys caps the items and reports truncation when more objects exist", async () => {
    const { result } = await withStrictS3(
      () => listXml(["a", "b", "c"]),
      () => list(s3Connector(keyedConfig), { maxKeys: 2 }),
    );
    const body = result.body as {
      items: Array<{ key: string }>;
      count: number;
      truncated: boolean;
    };
    expect(body.items.map((item) => item.key)).toEqual(["a", "b"]);
    expect(body.count).toBe(2);
    expect(body.truncated).toBe(true);
  });

  test("exactly maxKeys objects and nothing more is not reported as truncated", async () => {
    const { result } = await withStrictS3(
      () => listXml(["a", "b"]),
      () => list(s3Connector(keyedConfig), { maxKeys: 2 }),
    );
    const body = result.body as { count: number; truncated: boolean };
    expect(body.count).toBe(2);
    expect(body.truncated).toBe(false);
  });

  test("without paginate the listing stops at 1000 objects even when maxKeys is larger", async () => {
    const { result } = await withStrictS3(
      () => listXml(keys(1001)),
      () => list(s3Connector(keyedConfig), { maxKeys: 5000 }),
    );
    const body = result.body as { count: number; truncated: boolean; paginated: boolean };
    expect(body).toMatchObject({ count: 1000, truncated: true, paginated: false });
  });

  test("with paginate the listing passes 1000 objects up to maxKeys", async () => {
    const { result } = await withStrictS3(
      () => listXml(keys(1001)),
      () => list(s3Connector(keyedConfig), { maxKeys: 5000, paginate: true }),
    );
    const body = result.body as { count: number; truncated: boolean; paginated: boolean };
    expect(body).toMatchObject({ count: 1001, truncated: false, paginated: true });
  });

  test("with paginate maxKeys is capped at 10000 objects", async () => {
    const { result } = await withStrictS3(
      () => listXml(keys(10_001)),
      () => list(s3Connector(keyedConfig), { maxKeys: 20_000, paginate: true }),
    );
    const body = result.body as { count: number; truncated: boolean };
    expect(body).toMatchObject({ count: 10_000, truncated: true });
  });

  test("an access-denied listing surfaces the server error code and status", async () => {
    const { result } = await withStrictS3(
      () =>
        new Response(
          "<Error><Code>AccessDenied</Code><Message>denied</Message><Key></Key></Error>",
          { status: 403, headers: { "content-type": "application/xml" } },
        ),
      () => list(s3Connector(keyedConfig)).catch((error: unknown) => error),
    );
    expect(result).toMatchObject({ statusCode: 403, code: "AccessDenied" });
  });

  test("a private endpoint is refused in strict mode before credentials are used", async () => {
    const used: unknown[] = [];
    const { result, requests } = await withStrictS3(
      () => listXml([]),
      () =>
        list(s3Connector({ ...keyedConfig, endpoint: "http://10.0.0.5:9000" }), {
          on_credential_use: async (snapshot) => {
            used.push(snapshot);
          },
        }).catch((error: unknown) => error),
    );
    expect(requests).toHaveLength(0);
    expect(used).toHaveLength(0);
    expect((result as Error).message).toContain("private_ip_blocked");
  });

  test("credential use is reported once with the connector snapshot before dispatch", async () => {
    const used: unknown[] = [];
    const { requests } = await withStrictS3(
      () => listXml([]),
      () =>
        list(s3Connector(keyedConfig), {
          on_credential_use: async (snapshot) => {
            used.push(snapshot);
          },
        }),
    );
    expect(requests).toHaveLength(1);
    expect(used).toEqual([
      {
        connector_id: "00000000-0000-4000-8000-0000000000b1",
        environment: "dev",
        credential_id: null,
        credential_generation: null,
        connection_id: null,
        access_token_version: null,
        identity: null,
      },
    ]);
  });
});
