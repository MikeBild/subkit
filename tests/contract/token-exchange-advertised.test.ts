// The RFC 8693 token exchange has to be VISIBLE everywhere a machine caller
// looks before it ever sends a request: the discovery document, the
// committed OpenAPI contract, the host CLI's --help, the docs. This pins the
// four together — dropping the grant from one of them without the others is
// the drift this test refuses.
//
// Runtime behaviour (mint, use, revoke) lives in
// apps/engine/src/http/tests/token-exchange.test.ts.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const SUBJECT_TYPE = "urn:subkit:params:oauth:token-type:api-key";

function read(rel: string): string {
  return readFileSync(join(REPO, rel), "utf8");
}

describe("token exchange is advertised", () => {
  test("discovery document names the grant", () => {
    const discovery = read("apps/engine/src/http/routes/oauth/discovery.ts");
    expect(discovery).toContain("TOKEN_EXCHANGE_GRANT_TYPE");
    expect(read("apps/engine/src/auth/oauth/token-exchange.ts")).toContain(
      `TOKEN_EXCHANGE_GRANT_TYPE = "${GRANT}"`,
    );
  });

  test("committed OpenAPI describes the grant on POST /v1/oauth/token", () => {
    const spec = JSON.parse(read("packages/cli-core/src/engine-api/openapi.json")) as {
      paths: Record<string, { post?: { description?: string } }>;
    };
    const description = spec.paths["/v1/oauth/token"]?.post?.description ?? "";
    expect(description).toContain(GRANT);
    expect(description).toContain(SUBJECT_TYPE);
    expect(description).toContain("3600");
  });

  test("engine --help carries the runbook entry", () => {
    const help = read("apps/engine/src/help-text.ts");
    expect(help).toContain("--token-exchange");
    expect(help).toContain("--key-file <path>");
    expect(help).toContain("--ttl <seconds>");
  });

  test("the developer docs page exists and is linked from the section index", () => {
    const page = read("docs/developers/token-exchange.md");
    expect(page).toContain(GRANT);
    expect(page).toContain(SUBJECT_TYPE);
    expect(page).toContain("--token-exchange");
    expect(read("docs/developers/README.md")).toContain("token-exchange.md");
  });
});
