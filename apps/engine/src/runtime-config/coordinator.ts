import { eq } from "drizzle-orm";
import type { Config } from "../config/schema.ts";
import type { Db, Executor } from "../db/client.ts";
import { runtimeConfigReplicas, runtimeConfigState } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import { CONFIG_STATE_KEY, defaultReplicaInstanceId, REPLICA_HEARTBEAT_MS } from "./contracts.ts";
import {
  applyRuntimeConfig,
  getRuntimeConfigState,
  getRuntimeRevision,
  prepareRuntimeConfig,
} from "./service.ts";
import { runtimeStateColumns } from "./state-columns.ts";

import {
  assertVaultMasterKey,
  lockVaultParticipation,
  withVaultStartupGate,
} from "./vault-participation.ts";

export class RuntimeConfigCoordinator {
  readonly instanceId: string;
  private activeRevision: number | null = null;
  private prepared = new Map<number, Config>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeatAt = 0;
  private task: Promise<void> | null = null;
  private paused = true;
  private closed = false;

  constructor(
    private readonly db: Db,
    private readonly productVersion: string,
    instanceId = defaultReplicaInstanceId(),
  ) {
    this.instanceId = instanceId;
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error("runtime_config_coordinator_stopped");
    if (!this.paused) return this.task ?? Promise.resolve();
    if (this.task) throw new Error("runtime_config_coordinator_busy");
    this.paused = false;
    return this.track(async () => {
      try {
        const state = await getRuntimeConfigState(this.db);
        if (this.paused) return;
        this.activeRevision = state.active_revision;
        await this.heartbeat();
        if (this.paused) return;
        await this.runTick();
        if (this.paused) return;
        this.timer = setInterval(() => void this.tick(), 1_000);
        this.timer.unref?.();
      } catch (error) {
        this.paused = true;
        throw error;
      }
    });
  }

  async pause(): Promise<void> {
    this.paused = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.task;
  }

  async stop(): Promise<void> {
    this.closed = true;
    await this.pause();
    await this.db
      .delete(runtimeConfigReplicas)
      .where(eq(runtimeConfigReplicas.instance_id, this.instanceId));
  }

  private track(operation: () => Promise<void>): Promise<void> {
    const task = operation();
    this.task = task;
    return task.finally(() => {
      if (this.task === task) this.task = null;
    });
  }

  private tick(): Promise<void> {
    if (this.paused) return Promise.resolve();
    if (this.task) return this.task;
    return this.track(() => this.runTick());
  }

  async registerStartup(initialize: (tx: Executor) => Promise<void>): Promise<void> {
    if (this.closed) throw new Error("runtime_config_coordinator_stopped");
    if (this.task || !this.paused) throw new Error("runtime_config_coordinator_busy");
    return this.track(() =>
      withVaultStartupGate(this.db, async (tx) => {
        await initialize(tx);
        if (this.closed) throw new Error("runtime_config_coordinator_stopped");
        const state = await getRuntimeConfigState(tx);
        this.activeRevision = state.active_revision;
        await this.heartbeat(tx);
      }),
    );
  }

  private async heartbeat(executor?: Executor): Promise<void> {
    const write = async (tx: Executor) => {
      await lockVaultParticipation(tx);
      await assertVaultMasterKey(tx);
      const now = new Date();
      await tx
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
      this.lastHeartbeatAt = now.getTime();
    };
    if (executor) await write(executor);
    else await this.db.transaction(write);
  }

  private async runTick(): Promise<void> {
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
        .select(runtimeStateColumns)
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
    }
  }
}
