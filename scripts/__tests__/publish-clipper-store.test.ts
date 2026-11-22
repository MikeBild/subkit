import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type PublishDeps,
  publishToStore,
  STORE_SECRETS,
  storeCredentials,
  storeUrls,
  tokenRequestBody,
  uploadState,
} from "../publish-clipper-store.ts";

const ROOT = join(import.meta.dir, "..", "..");

const env = {
  CHROME_WEB_STORE_CLIENT_ID: "client",
  CHROME_WEB_STORE_CLIENT_SECRET: "secret",
  CHROME_WEB_STORE_REFRESH_TOKEN: "refresh",
  CHROME_WEB_STORE_PUBLISHER_ID: "publisher",
};

const credentials = {
  clientId: "client",
  clientSecret: "secret",
  refreshToken: "refresh",
  publisherId: "publisher",
  extensionId: "odefbnmjeehgfbanpaajiaocliccldma",
};

describe("storeCredentials", () => {
  test("reads the four secrets and uses the published extension ID", () => {
    expect(storeCredentials(env)).toEqual(credentials);
  });

  test("skips publishing when no secret is set", () => {
    expect(storeCredentials({})).toBeNull();
    expect(storeCredentials({ CHROME_WEB_STORE_CLIENT_ID: " " })).toBeNull();
  });

  test("names the secrets that are missing from a partial set", () => {
    expect(() =>
      storeCredentials({
        ...env,
        CHROME_WEB_STORE_PUBLISHER_ID: "",
        CHROME_WEB_STORE_REFRESH_TOKEN: undefined,
      }),
    ).toThrow(
      "Chrome Web Store secrets missing: CHROME_WEB_STORE_REFRESH_TOKEN, CHROME_WEB_STORE_PUBLISHER_ID",
    );
  });
});

describe("store requests", () => {
  test("address the item of the publisher", () => {
    expect(storeUrls(credentials)).toEqual({
      token: "https://oauth2.googleapis.com/token",
      upload:
        "https://chromewebstore.googleapis.com/upload/v2/publishers/publisher/items/odefbnmjeehgfbanpaajiaocliccldma:upload",
      status:
        "https://chromewebstore.googleapis.com/v2/publishers/publisher/items/odefbnmjeehgfbanpaajiaocliccldma:fetchStatus",
      publish:
        "https://chromewebstore.googleapis.com/v2/publishers/publisher/items/odefbnmjeehgfbanpaajiaocliccldma:publish",
    });
  });

  test("exchange the refresh token", () => {
    expect(Object.fromEntries(tokenRequestBody(credentials))).toEqual({
      client_id: "client",
      client_secret: "secret",
      refresh_token: "refresh",
      grant_type: "refresh_token",
    });
  });

  test("read the upload state", () => {
    expect(uploadState("SUCCEEDED")).toBe("SUCCEEDED");
    expect(uploadState("IN_PROGRESS")).toBe("IN_PROGRESS");
    expect(uploadState("FAILED")).toBe("FAILED");
    expect(uploadState(undefined)).toBe("UNKNOWN");
  });
});

function store(responses: Array<[number, unknown]>) {
  const calls: Array<{ url: string; method: string | undefined }> = [];
  const logs: string[] = [];
  const deps: PublishDeps = {
    fetch: async (url, init) => {
      calls.push({ url, method: init.method });
      const [status, body] = responses.shift() ?? [500, {}];
      return new Response(JSON.stringify(body), { status });
    },
    wait: async () => {},
    log: (line) => logs.push(line),
  };
  return { deps, calls, logs };
}

describe("publishToStore", () => {
  test("uploads, waits for processing and submits for review", async () => {
    const run = store([
      [200, { access_token: "token" }],
      [200, { uploadState: "IN_PROGRESS" }],
      [200, { lastAsyncUploadState: "SUCCEEDED" }],
      [200, {}],
    ]);
    await publishToStore(credentials, new Uint8Array([1]), run.deps);
    expect(run.calls.map((call) => call.url.split(/[/:]/).at(-1))).toEqual([
      "token",
      "upload",
      "fetchStatus",
      "publish",
    ]);
    expect(run.logs).toEqual([
      "Chrome Web Store: upload succeeded",
      "Chrome Web Store: submitted for review",
    ]);
  });

  test("does not publish a failed upload", async () => {
    const run = store([
      [200, { access_token: "token" }],
      [200, { uploadState: "FAILED" }],
    ]);
    await expect(publishToStore(credentials, new Uint8Array([1]), run.deps)).rejects.toThrow(
      "Chrome Web Store upload ended as FAILED",
    );
    expect(run.calls).toHaveLength(2);
  });

  test("stops after the last poll", async () => {
    const run = store([
      [200, { access_token: "token" }],
      [200, { uploadState: "IN_PROGRESS" }],
      [200, { lastAsyncUploadState: "IN_PROGRESS" }],
    ]);
    await expect(publishToStore(credentials, new Uint8Array([1]), run.deps, 1)).rejects.toThrow(
      "Chrome Web Store upload ended as IN_PROGRESS",
    );
  });

  test("reports a rejected token exchange without its body", async () => {
    const run = store([[400, { error: "invalid_grant", error_description: "secret detail" }]]);
    await expect(publishToStore(credentials, new Uint8Array([1]), run.deps)).rejects.toThrow(
      "Chrome Web Store token exchange failed with HTTP 400",
    );
  });
});

describe("release workflow", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");

  test("passes every store secret to the publish step after the release is public", () => {
    const publish = workflow.indexOf("scripts/publish-clipper-store.ts assets/subkit-clipper.zip");
    expect(publish).toBeGreaterThan(workflow.indexOf('gh release edit "$TAG" --draft=false'));
    for (const name of STORE_SECRETS) {
      expect(workflow).toContain(`${name}: \${{ secrets.${name} }}`);
    }
  });
});

describe("store listing", () => {
  const manifest = JSON.parse(
    readFileSync(join(ROOT, "apps/clipper/public/manifest.json"), "utf8"),
  ) as {
    name: string;
    description: string;
    permissions: string[];
    optional_host_permissions: string[];
  };
  const listing = JSON.parse(
    readFileSync(join(ROOT, "apps/clipper/store/listing.json"), "utf8"),
  ) as {
    name: string;
    summary: Record<"en" | "de", string>;
    description: Record<"en" | "de", string>;
    single_purpose: Record<"en" | "de", string>;
    permissions: Record<string, Record<"en" | "de", string>>;
  };

  test("matches the manifest name and description", () => {
    expect(listing.name).toBe(manifest.name);
    expect(listing.summary.en).toBe(manifest.description);
  });

  test("keeps both summaries within the store limit", () => {
    expect(listing.summary.en.length).toBeLessThanOrEqual(132);
    expect(listing.summary.de.length).toBeLessThanOrEqual(132);
  });

  test("justifies every permission in both languages", () => {
    const requested = [...manifest.permissions, "optional_host_permissions"].sort();
    expect(Object.keys(listing.permissions).sort()).toEqual(requested);
    for (const reason of Object.values(listing.permissions)) {
      expect(reason.en.length).toBeGreaterThan(0);
      expect(reason.de.length).toBeGreaterThan(0);
    }
  });

  test("writes description and single purpose in both languages", () => {
    for (const field of [listing.description, listing.single_purpose]) {
      expect(field.en.length).toBeGreaterThan(0);
      expect(field.de.length).toBeGreaterThan(0);
    }
  });
});
