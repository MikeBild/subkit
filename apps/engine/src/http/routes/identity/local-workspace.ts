import type { OpenAPIHono } from "@hono/zod-openapi";
import { LOCAL_WORKSPACE_PATHS } from "@shared/device/local-launch.ts";
import { loopbackModelOrigin } from "@shared/local-model-server.ts";
import { z } from "zod";
import {
  ensureLocalOwner,
  exportLocalWorkspace,
  forgetModelServerCapability,
  type LocalWorkspace,
  localWorkspaceActivity,
  probeModelServer,
  saveModelServerCapability,
  storeLocalAiAccess,
} from "../../../identity/index.ts";
import { pauseQueueWorkers, queueWorkersPaused, resumeQueueWorkers } from "../../../queue/index.ts";
import { now } from "../../../utils/clock.ts";
import { type AppEnv, OPENAPI_INFO } from "../../openapi.ts";
import { launcherRefusal } from "./local-session.ts";

const LocalAiAccessSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("provider"),
      provider: z.enum(["anthropic", "openai", "gemini"]),
      api_key: z.string().min(1).max(4096),
    })
    .strict(),
  z.object({ kind: z.literal("model_server"), origin: z.string().min(1).max(512) }).strict(),
]);

const LocalMoveSchema = z.object({ server_origin: z.string().url().max(2048) }).strict();
const LocalWorkersSchema = z.object({ paused: z.boolean() }).strict();

export function registerLocalWorkspaceRoutes(
  app: OpenAPIHono<AppEnv>,
  workspace: LocalWorkspace,
): void {
  app.put(LOCAL_WORKSPACE_PATHS.ai_access, async (c) => {
    const refused = launcherRefusal(c, workspace);
    if (refused) return refused;
    const parsed = LocalAiAccessSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ code: "validation_failed", message: "invalid AI access" }, 400);
    const db = c.get("db");
    const owner = await ensureLocalOwner(db, undefined);
    if (!owner.ok) return c.json({ code: owner.code, message: "no local owner yet" }, 409);
    const body = parsed.data;
    if (body.kind === "provider") {
      const stored = await storeLocalAiAccess(db, owner, body);
      if (!stored.ok)
        return c.json(
          { code: stored.code, message: "the provider did not accept the key" },
          stored.code === "llm_provider_unreachable" ? 502 : 422,
        );
      await forgetModelServerCapability(db);
      return c.json({ kind: "provider", provider: body.provider }, 200);
    }
    const origin = loopbackModelOrigin(body.origin);
    if (!origin)
      return c.json(
        { code: "model_server_not_loopback", message: "a model server runs on this device" },
        422,
      );
    const capability = await probeModelServer(origin, new Date(now()));
    await saveModelServerCapability(db, capability);
    await storeLocalAiAccess(db, owner, {
      kind: "model_server",
      origin,
      model: capability.model,
    });
    return c.json(
      {
        kind: "model_server",
        origin,
        model: capability.model,
        reachable: capability.reachable,
        tools: capability.tools,
      },
      200,
    );
  });

  app.post(LOCAL_WORKSPACE_PATHS.move_to_server, async (c) => {
    const refused = launcherRefusal(c, workspace);
    if (refused) return refused;
    const parsed = LocalMoveSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ code: "validation_failed", message: "invalid server address" }, 400);
    const db = c.get("db");
    const owner = await ensureLocalOwner(db, undefined);
    if (!owner.ok) return c.json({ code: owner.code, message: "no local owner yet" }, 409);
    const exported = await exportLocalWorkspace(db, owner, {
      server_origin: parsed.data.server_origin,
      engine_version: OPENAPI_INFO.version,
    });
    return new Response(new Uint8Array(exported.bytes), {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${exported.filename}"`,
        "x-subkit-file-id": exported.file_id,
        "cache-control": "no-store",
      },
    });
  });

  app.put(LOCAL_WORKSPACE_PATHS.workers, async (c) => {
    const refused = launcherRefusal(c, workspace);
    if (refused) return refused;
    const parsed = LocalWorkersSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ code: "validation_failed", message: "invalid worker state" }, 400);
    if (parsed.data.paused) await pauseQueueWorkers();
    else await resumeQueueWorkers();
    return c.json({ paused: queueWorkersPaused() }, 200);
  });

  app.get(LOCAL_WORKSPACE_PATHS.activity, async (c) => {
    const refused = launcherRefusal(c, workspace);
    if (refused) return refused;
    const db = c.get("db");
    const owner = await ensureLocalOwner(db, undefined);
    const active = owner.ok ? await localWorkspaceActivity(db, owner.tenant_id) : 0;
    return c.json({ active_runs: active, workers_paused: queueWorkersPaused() }, 200);
  });
}
