import { afterAll, beforeAll } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { apiKeys, users } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { createDeterministicHexFactory } from "../../test-helpers/determinism/ids.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

export let srv: HttpTestServer;

export let enduserKey = "";

export const BUNDLE_PATH = "/v1/knowledge-sources/bundle";

export function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

export function postBundle(body: unknown, key = srv.apiKey): Promise<Response> {
  return fetch(`${srv.baseUrl}${BUNDLE_PATH}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function postBundleAfterCatalogConflict(body: unknown): Promise<Response> {
  let response = await postBundle(body);
  const busy = async () =>
    response.status === 409 &&
    ((await response.clone().json()) as { code?: string }).code === "catalog_vocabulary_changed";
  await waitFor(
    async () => {
      if (!(await busy())) return true;
      response = await postBundle(body);
      return !(await busy());
    },
    { tries: 100, sleepMs: 5, label: "bundle import after catalog conflict" },
  );
  return response;
}

export const WIKI = {
  name: "Team Wiki",
  slug: "team-wiki",
  files: [
    { path: "index.md", content: "# Team Wiki\n\n* [Deploy](runbooks/deploy.md)" },
    { path: "log.md", content: "## 2026-07-01\n* Created." },
    {
      path: "runbooks/deploy.md",
      content:
        "---\ntype: Runbook\ntitle: Deploy\ntags: [ops]\n---\n# Deploy\n\nRun the deploy script.",
    },
    { path: "notes/plain.md", content: "Plain note without frontmatter." },
  ],
};

export let nextCleanupHex = createDeterministicHexFactory(0x482c1e);

export function setupKnowledgeBundle(): void {
  nextCleanupHex = createDeterministicHexFactory(0x482c1e);
  enduserKey = "";
  beforeAll(async () => {
    srv = await createHttpTestServer("kb-bundle");

    const [enduser] = await srv.db
      .insert(users)
      .values({
        tenant_id: srv.tenantId,
        email: "enduser-bundle@test.local",
        role_id: await builtinRoleId(srv.db, "enduser"),
      })
      .returning();
    const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: test only
    const plaintext = `wf_live_${rand}`;
    await srv.db.insert(apiKeys).values({
      tenant_id: srv.tenantId,
      user_id: enduser!.id,
      prefix: plaintext.slice(0, 12),
      token_sha256: sha256Hex(plaintext),
      scopes: ["*"],
    });
    enduserKey = plaintext;
  }, 60_000);
  afterAll(async () => {
    await srv.cleanup();
  }, 60_000);
}
