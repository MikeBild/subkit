import { afterAll, beforeAll, beforeEach, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, loadConfig } from "../../config/loader.ts";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { resetMockProvider } from "../../llm/mock-provider.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { withSelfHostedDriverFetchForTests } from "../../test-helpers/driver-fetch.ts";
import { _withConnectorPreflightForTests } from "../authoring-preflight.ts";
import { createEmptyDraftDocument } from "../authoring-state/index.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";

export const nextUuid = createDeterministicUuidFactory(0xa07_40);

export let ctx: TestDb;
export let tenant_id: string;

export async function ensureConfigLoaded(): Promise<void> {
  try {
    getConfig();
    return;
  } catch {}
  const dir = mkdtempSync(join(tmpdir(), "sk-cfg-authoring-pipeline-"));
  await loadConfig({
    env: {
      DATABASE_URL: "postgres://placeholder/authoring-pipeline",
      NODE_ENV: "test",
      LLM_PROVIDER: "mock",
    },
    configPathOverride: join(dir, "subkit.config.json"),
  });
}

export let fetchCalls = 0;

export const tripwire = ((..._args: unknown[]) => {
  fetchCalls += 1;
  throw new Error("live HTTP is forbidden inside the authoring pipeline");
}) as unknown as typeof fetch;

export function tw(name: string, body: () => Promise<void>) {
  test(name, () =>
    withSelfHostedDriverFetchForTests(tripwire, () =>
      _withConnectorPreflightForTests(async () => null, body),
    ),
  );
}

export function makeCtx(): ToolContext & { _draft: { value: DraftDocument | null } } {
  const ref: { value: DraftDocument | null } = { value: null };
  return {
    db: ctx.db,
    tenant_id,
    conversation_id: nextUuid(),
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({ tenant_id, actor_id: null, db: ctx.db }),
    getDraft: () => ref.value ?? createEmptyDraftDocument(),
    setDraft: async (d) => {
      ref.value = d;
    },
    _draft: ref,
  };
}

export const VALID_DEF = {
  name: "Top repos digest",
  slug: "top-repos-digest",
  description: "Fetch repos and shape the top entries.",
  steps: [
    {
      id: "fetch_repos",
      kind: "request",
      method: "GET",
      url: "https://jsonplaceholder.typicode.com/posts",
    },
    {
      id: "shape_repos",
      kind: "transform",
      language: "javascript",
      expression:
        "const repos = input.scope.fetch_repos.data; return repos.map(r => ({ name: r.name }));",
    },
  ],
  output_schema: { type: "array" },
};

export const NEVER_VALID_DEF = {
  name: "Broken loop",
  slug: "broken-loop",
  steps: [
    {
      id: "fetch",
      kind: "request",
      method: "GET",
      url: "https://jsonplaceholder.typicode.com/todos",
    },
    { id: "iter", kind: "loop", over: "$scope.fetch.data", body: ["missing_step"] },
  ],
};

export function useAuthoringPipelineSetup(): void {
  beforeAll(async () => {
    await ensureConfigLoaded();
    ctx = await createTestDb("authoring_pipeline");
    const [t] = await ctx.db
      .insert(tenants)
      .values({ slug: "t-author-pipeline", display_name: "T" })
      .returning();
    tenant_id = t!.id;
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(() => {
    resetMockProvider();
    fetchCalls = 0;
  });
}
