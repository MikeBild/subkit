import { eq } from "drizzle-orm";
import type { Config } from "../config/schema.ts";
import type { Db } from "../db/client.ts";
import { runtimeConfigReplicas, runtimeConfigState } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import { CONFIG_STATE_KEY, defaultReplicaInstanceId, REPLICA_HEARTBEAT_MS } from "./contracts.ts";
import {
  applyRuntimeConfig,
  getRuntimeConfigState,
  getRuntimeRevision,
  prepareRuntimeConfig,
} from "./service.ts";

/** Per-process replica lease and prepare/ACK coordinator. The canonical
 * revision store remains in service.ts; this class only projects committed
 * pointers into one running replica. */
export class RuntimeConfigCoordinator {
  readonly instanceId: string;
  private activeRevision: number | null = null;
  private prepared = new Map<number, Config>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeatAt = 0;
  private ticking = false;

  constructor(
    private readonly db: Db,
    private readonly productVersion: string,
    instanceId = defaultReplicaInstanceId(),
  ) {
    this.instanceId = instanceId;
  }

  async start(): Promise<void> {
    const state = await getRuntimeConfigState(this.db);
    this.activeRevision = state.active_revision;
    await this.heartbeat();
    await this.tick();
    this.timer = setInterval(() => void this.tick(), 1_000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (let attempt = 0; this.ticking && attempt < 500; attempt += 1) {
      await Bun.sleep(10);
    }
    await this.db
      .delete(runtimeConfigReplicas)
      .where(eq(runtimeConfigReplicas.instance_id, this.instanceId));
  }

  private async heartbeat(): Promise<void> {
    const now = new Date();
    this.lastHeartbeatAt = now.getTime();
    await this.db
      .insert(runtimeConfigReplicas)
      .values({
        instance_id: this.instanceId,
        product_version: this.productVersion,
        last_seen_at: now,
        active_revision: this.activeRevision,
      })
      .onConflictDoUpdate({
        target: runtimeConfigReplicas.instance_id,
        set: {
          product_version: this.productVersion,
          last_seen_at: now,
          active_revision: this.activeRevision,
          updated_at: now,
        },
      });
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (Date.now() - this.lastHeartbeatAt >= REPLICA_HEARTBEAT_MS) await this.heartbeat();
      // tenant-filter:exempt — replica leases are product-global runtime state.
      const [replica] = await this.db
        .select()
        .from(runtimeConfigReplicas)
        .where(eq(runtimeConfigReplicas.instance_id, this.instanceId))
        .limit(1);
      if (replica?.desired_revision && replica.ack_revision !== replica.desired_revision) {
        const revision = await getRuntimeRevision(this.db, replica.desired_revision);
        try {
          const prepared = await prepareRuntimeConfig(this.db, revision);
          this.prepared.set(revision.revision, prepared);
          await this.db
            .update(runtimeConfigReplicas)
            .set({
              ack_revision: revision.revision,
              ack_digest: revision.digest,
              ack_status: "ack",
              ack_reason: null,
              updated_at: new Date(),
            })
            .where(eq(runtimeConfigReplicas.instance_id, this.instanceId));
        } catch (error) {
          await this.db
            .update(runtimeConfigReplicas)
            .set({
              ack_revision: revision.revision,
              ack_digest: null,
              ack_status: "nack",
              ack_reason: error instanceof Error ? error.message.slice(0, 1_000) : String(error),
              updated_at: new Date(),
            })
            .where(eq(runtimeConfigReplicas.instance_id, this.instanceId));
        }
      }

      // tenant-filter:exempt — the active pointer is product-global runtime state.
      const [state] = await this.db
        .select()
        .from(runtimeConfigState)
        .where(eq(runtimeConfigState.key, CONFIG_STATE_KEY))
        .limit(1);
      if (state?.active_revision && state.active_revision !== this.activeRevision) {
        const revision = await getRuntimeRevision(this.db, state.active_revision);
        const config =
          this.prepared.get(revision.revision) ?? (await prepareRuntimeConfig(this.db, revision));
        await applyRuntimeConfig(config);
        this.activeRevision = revision.revision;
        this.prepared.delete(revision.revision);
        await this.heartbeat();
        logger.info({
          module: "runtime_config",
          action: "revision.applied",
          msg: "runtime configuration revision applied",
          revision: revision.revision,
          digest: revision.digest,
          instance_id: this.instanceId,
        });
      }
    } catch (error) {
      logger.error({
        module: "runtime_config",
        action: "coordinator.tick_failed",
        msg: "runtime configuration coordinator tick failed",
        instance_id: this.instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.ticking = false;
    }
  }
}
