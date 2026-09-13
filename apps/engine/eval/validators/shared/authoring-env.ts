// Shared environment for the authoring eval scenarios (Fix E, CI mode).
//
// The authoring scenarios exercise the REAL engine seams — the one-shot
// pipeline, the preview-judge gate, hold-writes previews, the recorded
// evaluation + bounded repair — against the deterministic in-process
// mock LLM provider (`LLM_PROVIDER=mock`). That requires the same
// scaffolding the conversation unit tests use: a loaded config, a
// disposable per-validator database (created + dropped around the
// scenario, same `createTestDb` isolation contract as `bun test`), a
// seeded tenant, and a minimal `ToolContext` whose draft lives in
// memory.
//
// Zero live HTTP is a hard contract for every scenario: `withEgressTripwire`
// replaces `globalThis.fetch` with a counter that throws, so any code
// path that tries to leave the process fails the fixture loudly.

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

/** Bootstrap the config loader once per eval-runner process with the
 *  mock LLM provider pinned. Idempotent — mirrors the conversation
 *  test setup so `invoke()` routes to the in-process mock. */
async function ensureConfigLoaded(): Promise<void> {
  process.env.LLM_PROVIDER = "mock";
  try {
    getConfig();
    return;
  } catch {
    // not yet loaded — fall through.
  }
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
  /** Build a fresh ToolContext with an in-memory draft slot. */
  makeToolCtx: (initialDraft?: DraftDocument) => ToolContext & { current: () => DraftDocument };
}

let uuidCounter = 0;
/** Deterministic-enough conversation ids for tool contexts — the
 *  scenarios never join on them across runs. */
function nextUuid(): string {
  uuidCounter += 1;
  const tail = uuidCounter.toString(16).padStart(12, "0");
  return `00000000-e0a1-4000-8000-${tail}`;
}

/**
 * Run `fn` against a freshly created database + seeded tenant, then
 * drop the database — every scenario is fully self-contained, exactly
 * like one `bun test` file.
 */
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

/**
 * Egress tripwire: while `fn` runs, every `fetch` attempt throws and is
 * counted. The returned count MUST be asserted to be 0 by the caller —
 * the throw alone may be swallowed by intermediate error handling.
 */
export async function withEgressTripwire<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; fetch_calls: number }> {
  // Installed through the driver-fetch seam: drivers capture the real
  // fetch at module load, so a globalThis stub would miss real egress —
  // and would leak into sibling test files under concurrent execution.
  // The seam is async-context-scoped, so the tripwire must wrap `fn`
  // explicitly (store.run) — everything awaited inside sees it, nothing
  // outside does.
  let fetch_calls = 0;
  const tripwire = ((..._args: unknown[]) => {
    fetch_calls += 1;
    throw new Error("live HTTP is forbidden inside CI-mode authoring eval scenarios");
  }) as unknown as typeof fetch;
  const result = await withDriverFetchForTests(tripwire, fn);
  return { result, fetch_calls };
}

/** First failed check wins — tiny assertion collector so validators
 *  report one precise reason instead of throwing. */
export class Checks {
  private failure: string | null = null;
  check(ok: boolean, reason: string): void {
    if (!ok && this.failure === null) this.failure = reason;
  }
  get failed(): string | null {
    return this.failure;
  }
}
