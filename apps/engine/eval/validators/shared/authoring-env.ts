import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, loadConfig } from "../../../src/config/loader.ts";
import { createEmptyDraftDocument } from "../../../src/conversations/authoring-state.ts";
import type { ToolContext } from "../../../src/conversations/tools/index.ts";
import type { DraftDocument } from "../../../src/conversations/types.ts";
import type { Db } from "../../../src/db/client.ts";
import { tenants } from "../../../src/db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../src/db/tests/setup.ts";
import { EngineClient } from "../../../src/engine-client/index.ts";
import { resetMockProvider } from "../../../src/llm/mock-provider.ts";
import { withDriverFetchForTests } from "../../../src/test-helpers/driver-fetch.ts";

async function ensureConfigLoaded(): Promise<void> {
  process.env.LLM_PROVIDER = "mock";
  try {
    getConfig();
    return;
  } catch {}
  const dir = mkdtempSync(join(tmpdir(), "sk-cfg-eval-authoring-"));
  await loadConfig({
    env: {
      DATABASE_URL: "postgres://placeholder/eval-authoring",
      NODE_ENV: "test",
      LLM_PROVIDER: "mock",
    },
    configPathOverride: join(dir, "subkit.config.json"),
  });
}

export interface AuthoringEvalEnv {
  db: Db;
  tenant_id: string;
  makeToolCtx: (initialDraft?: DraftDocument) => ToolContext & { current: () => DraftDocument };
}

let uuidCounter = 0;
function nextUuid(): string {
  uuidCounter += 1;
  const tail = uuidCounter.toString(16).padStart(12, "0");
  return `00000000-e0a1-4000-8000-${tail}`;
}

export async function withAuthoringEvalEnv<T>(
  label: string,
  fn: (env: AuthoringEvalEnv) => Promise<T>,
): Promise<T> {
  await ensureConfigLoaded();
  resetMockProvider();
  const testDb: TestDb = await createTestDb(`eval_${label}`);
  try {
    const [tenant] = await testDb.db
      .insert(tenants)
      .values({ slug: `t-eval-${label}`, display_name: `Eval ${label}` })
      .returning();
    if (!tenant) throw new Error("seed tenant failed");
    const tenant_id = tenant.id;

    const makeToolCtx: AuthoringEvalEnv["makeToolCtx"] = (initialDraft) => {
      let draft: DraftDocument = initialDraft ?? createEmptyDraftDocument();
      return {
        db: testDb.db,
        tenant_id,
        conversation_id: nextUuid(),
        actor_id: null,
        connector_id: null,
        workflow_id: null,
        engineClient: new EngineClient({ tenant_id, actor_id: null, db: testDb.db }),
        getDraft: () => draft,
        setDraft: async (next) => {
          draft = next;
        },
        current: () => draft,
      };
    };

    return await fn({ db: testDb.db, tenant_id, makeToolCtx });
  } finally {
    await testDb.cleanup();
    resetMockProvider();
  }
}

export async function withEgressTripwire<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; fetch_calls: number }> {
  let fetch_calls = 0;
  const tripwire = ((..._args: unknown[]) => {
    fetch_calls += 1;
    throw new Error("live HTTP is forbidden inside CI-mode authoring eval scenarios");
  }) as unknown as typeof fetch;
  const result = await withDriverFetchForTests(tripwire, fn);
  return { result, fetch_calls };
}

export class Checks {
  private failure: string | null = null;
  check(ok: boolean, reason: string): void {
    if (!ok && this.failure === null) this.failure = reason;
  }
  get failed(): string | null {
    return this.failure;
  }
}
