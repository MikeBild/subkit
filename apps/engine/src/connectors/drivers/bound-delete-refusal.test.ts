import { expect, test } from "bun:test";
import { S3Client } from "@bradenmacdonald/s3-lite-client";
import type { MaterializedRequest } from "../../execution/prepared-request.ts";
import { withSelfHostedDriverFetchForTests } from "../../test-helpers/driver-fetch.ts";
import { assertStorageRequest, storageBoundary } from "../../workflows/storage-boundary.ts";
import { RequestStepSchema } from "../../workflows/types.ts";
import { executeBoundS3Request } from "./s3-bound-dispatch.ts";

const ENDPOINT = "https://storage.example.com";
const BUCKET = "reports";

const deleteStep = RequestStepSchema.parse({
  id: "purge",
  kind: "request",
  protocol: "s3",
  connector_id: "00000000-0000-4000-8000-000000000001",
  method: "DELETE",
  s3: {
    key: "${item.key}",
    scope: { key_prefix: "v1/archive/", max_bytes: 10, max_deletes: 100 },
  },
});
const boundary = storageBoundary(deleteStep, `${ENDPOINT}/${BUCKET}/`)!;

function client(): S3Client {
  return new S3Client({
    endPoint: ENDPOINT,
    bucket: BUCKET,
    region: "local",
    accessKey: "test-access",
    secretKey: "test-secret",
    pathStyle: true,
  });
}

async function removeKey(key: string): Promise<{ error: unknown; fetches: number }> {
  let fetches = 0;
  let error: unknown = null;
  await withSelfHostedDriverFetchForTests(
    (() => {
      fetches += 1;
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as unknown as typeof fetch,
    async () => {
      try {
        await executeBoundS3Request({
          client: client(),
          params: {
            tenant_id: "00000000-0000-4000-8000-0000000000aa",
            method: "DELETE",
            path: key,
            before_dispatch: (_credential: unknown, request: MaterializedRequest) =>
              assertStorageRequest(boundary, request),
          } as never,
          credential: {
            credential_id: null,
            credential_revision: null,
            connection_authority: null,
          },
        });
      } catch (err) {
        error = err;
      }
    },
  );
  return { error, fetches };
}

test("a key inside the reviewed folder is dispatched", async () => {
  const { error, fetches } = await removeKey("v1/archive/2026-01-01.json");
  expect(error).toBeNull();
  expect(fetches).toBe(1);
});

test("a key outside the reviewed folder is refused before any request goes out", async () => {
  const { error, fetches } = await removeKey("v1/live/2026-01-01.json");
  expect(error).toMatchObject({ code: "execution_authority_changed" });
  expect(fetches).toBe(0);
});
