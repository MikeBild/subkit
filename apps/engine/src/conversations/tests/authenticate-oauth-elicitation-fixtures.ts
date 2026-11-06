import { afterAll, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { getConfig, loadConfig, setConfigKey } from "../../config/loader.ts";
import {
  type MockOAuthServer,
  startMockOAuthServer,
} from "../../credentials/oauth2/tests/mock-server.ts";
import { auditLog } from "../../db/schema/audit.ts";
import {
  connectors,
  conversationElicitations,
  conversations,
  tenants,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { startListener, stopListener } from "../../pubsub/listener.ts";
import type { ElicitationBridge, ElicitationResult } from "../elicitation-bridge.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";

export let ctx: TestDb;
export let mock: MockOAuthServer;
export let tenant_id: string;
export let conversation_id: string;
export let priorBaseUrl = "";

export async function ensureConfigLoaded(): Promise<void> {
  try {
    getConfig();
    return;
  } catch {}
  const dir = mkdtempSync(join(tmpdir(), "sk-cfg-aoauth-elicit-"));
  await loadConfig({
    env: { DATABASE_URL: "postgres://placeholder/aoauth-elicit", NODE_ENV: "test" },
    configPathOverride: join(dir, "subkit.config.json"),
  });
}

export async function makeOAuthConnector(slug: string): Promise<string> {
  const [c] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id,
      slug,
      display_name: `OAuth ${slug}`,
      driver: "http",
      environment: "dev",
      auth_type: "oauth2",
      base_url: "https://api.example.test",
      config: {
        oauth: {
          issuer_url: mock.baseUrl,
          client_id: "test-client",
          client_secret: "test-secret",
          scope: "read",
        },
      },
    })
    .returning({ id: connectors.id });
  return c!.id;
}

export function makeOobBridge(action: "accept" | "decline" = "accept"): ElicitationBridge {
  const fn = async (): Promise<ElicitationResult> => ({ action });
  return {
    capabilities: { form: true, oob: true },
    elicitForm: fn,
    elicitOob: fn,
  } as unknown as ElicitationBridge;
}

export async function readElicitations(convId: string) {
  return ctx.db
    .select()
    .from(conversationElicitations)
    .where(eq(conversationElicitations.conversation_id, convId));
}

export async function readResolveAudit(elicitationId: string, action: string) {
  const [row] = await ctx.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, tenant_id),
        eq(auditLog.resource_id, elicitationId),
        eq(auditLog.action, action),
      ),
    );
  return row;
}

export function buildCtx(
  connector_id: string,
  bridge: ElicitationBridge,
  draftRef: { current: DraftDocument },
): ToolContext {
  return {
    db: ctx.db,
    tenant_id,
    conversation_id,
    actor_id: null,
    connector_id,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id,
      actor_id: null,
      actor_type: "system",
      db: ctx.db,
    }),
    getDraft: () => draftRef.current,
    setDraft: async (next) => {
      draftRef.current = next;
    },
    abortSignal: new AbortController().signal,
    elicitationBridge: bridge,
  };
}

export function useAuthenticateOauthElicitationSetup(): void {
  beforeAll(async () => {
    await ensureConfigLoaded();
    priorBaseUrl = getConfig().server.public_base_url;
    await setConfigKey("server.public_base_url", "https://engine.test.example", { force: true });

    ctx = await createTestDb("authenticate_oauth_elicitation");
    mock = await startMockOAuthServer();

    const [t] = await ctx.db
      .insert(tenants)
      .values({ slug: "t-aoe", display_name: "T-AOE" })
      .returning();
    tenant_id = t!.id;

    const [conv] = await ctx.db
      .insert(conversations)
      .values({ tenant_id, status: "active" })
      .returning();
    conversation_id = conv!.id;

    await startListener({
      connectionString: ctx.url,
      db: ctx.db,
      channels: ["connector.oauth"],
      listenerId: "aoe-test",
    });
  });

  afterAll(async () => {
    await stopListener();
    await mock.close();
    await setConfigKey("server.public_base_url", priorBaseUrl, { force: true });
    await ctx.cleanup();
  });
}
