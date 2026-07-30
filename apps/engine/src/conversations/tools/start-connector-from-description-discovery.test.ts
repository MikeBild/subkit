// start_connector_from_description — the discovery step is best-effort.
//
// The tool runs endpoint discovery against the base_url the user just
// described, to recognise an auth scheme without asking. That call leaves the
// machine, so it is the one part of the tool that can fail for reasons which
// have nothing to do with the user's request: the host is down, DNS is
// blocked, the CI sandbox has no egress at all.
//
// The code says discovery failures "never block connector creation". That was
// a comment and nothing else — there was no test for this tool. It matters
// beyond this file: the mock e2e tracks author an open-meteo connector, and
// no template matches "open-meteo", so every one of those runs reaches a
// third-party host here. Whether those suites still hold with the network
// removed rested entirely on that unproven sentence.
//
// The failing case alone would be worthless — if the spy failed to intercept,
// it would pass because the real call succeeded. So the reachable case is
// asserted too: same tool, same arguments, discovery answering, and the
// recognised scheme showing up in the payload. One of these two tests going
// red is the signal; both green together is what makes either meaningful.

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as discoveryModule from "../../connectors/discovery/index.ts";
import { DiscoveryError, type DiscoveryResult } from "../../connectors/discovery/types.ts";
import { tenants } from "../../db/schema/identity.ts";
import { knowledgeChunks, knowledgeSources } from "../../db/schema/knowledge_sources.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import type { DraftDocument } from "../types.ts";
import type { ToolContext } from "./index.ts";
import { startConnectorFromDescriptionTool } from "./start-connector-from-description.ts";

let ctx: TestDb;
let tenant_id: string;

// A base_url no template matches — that is the precondition for the discovery
// branch to run at all. A templated vendor URL would skip it and the test
// would prove nothing.
const UNTEMPLATED_BASE_URL = "https://api.open-meteo.com";

const BEARER_RESULT: DiscoveryResult = {
  source_url: `${UNTEMPLATED_BASE_URL}/openapi.json`,
  fetched_at: "2026-04-26T00:00:00.000Z",
  strategy: "openapi-direct",
  spec_version: "openapi-3",
  title: "Untemplated API",
  servers: [UNTEMPLATED_BASE_URL],
  auth_schemes: [{ name: "bearer_auth", type: "http", scheme: "bearer" }],
  endpoints: [],
  warnings: [],
};

beforeAll(async () => {
  ctx = await createTestDb("start_connector_discovery");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-start-conn", display_name: "T" })
    .returning();
  tenant_id = t!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

afterEach(async () => {
  // runDiscoveryCached persists on success; a cached row would make the next
  // test skip the call it is trying to observe.
  await ctx.db.delete(knowledgeChunks);
  await ctx.db.delete(knowledgeSources);
});

interface Captured {
  draft: DraftDocument | null;
  context: ToolContext;
}

function makeCtx(): Captured {
  const captured: Captured = { draft: null, context: null as unknown as ToolContext };
  let draft: DraftDocument = { workflow: { name: "", steps: [] } } as DraftDocument;
  captured.context = {
    db: ctx.db,
    tenant_id,
    conversation_id: crypto.randomUUID(), // allow-random: identifier only, never asserted on
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({ tenant_id, actor_id: null, db: ctx.db }),
    getDraft: () => draft,
    setDraft: async (next: DraftDocument) => {
      draft = next;
      captured.draft = next;
    },
  } as ToolContext;
  return captured;
}

const ARGS = {
  name: "Open Meteo Forecast",
  description: "tomorrow's forecast for Berlin, no api key",
  base_url: UNTEMPLATED_BASE_URL,
  environment: "dev" as const,
};

describe("start_connector_from_description — discovery is best-effort", () => {
  test("an unreachable host still yields a connector draft", async () => {
    const spy = spyOn(discoveryModule, "discoverConnectorEndpoints").mockRejectedValue(
      new DiscoveryError("fetch_failed", "getaddrinfo ENOTFOUND api.open-meteo.com"),
    );
    try {
      const captured = makeCtx();
      const result = await startConnectorFromDescriptionTool.execute(captured.context, ARGS);

      // The user asked for a connector. Discovery is an optimisation on top of
      // that request, so its failure must not become the user's failure.
      expect(result.ok).toBe(true);
      expect(spy).toHaveBeenCalled();

      const data = (result as { ok: true; data: Record<string, unknown> }).data;
      const connector = data.connector as { slug: string; base_url?: string; auth_type: string };
      expect(connector.slug).toBe("open-meteo-forecast");

      // Nothing was recognised, so nothing may be claimed. Reporting a guessed
      // auth_type as `discovered_security_scheme` would be worse than reporting
      // none — the operator would stop looking.
      expect(data.recognized_auth).toBeUndefined();

      // And the draft is actually on the conversation, not just in the reply.
      expect(captured.draft).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  test("a reachable host has its auth scheme recognised", async () => {
    const spy = spyOn(discoveryModule, "discoverConnectorEndpoints").mockResolvedValue(
      BEARER_RESULT,
    );
    try {
      const result = await startConnectorFromDescriptionTool.execute(makeCtx().context, ARGS);
      expect(result.ok).toBe(true);

      const data = (result as { ok: true; data: Record<string, unknown> }).data;
      // This is the assertion that gives the test above its meaning: the spy
      // reaches the call inside runDiscoveryCached, so a rejection there is
      // genuinely what the tool had to survive.
      expect(data.recognized_auth).toMatchObject({
        auth_type: "bearer",
        scheme_name: "bearer_auth",
        source: "discovered_security_scheme",
      });
    } finally {
      spy.mockRestore();
    }
  });
});
