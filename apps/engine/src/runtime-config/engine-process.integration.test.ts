import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  runtimeConfigReplicas,
  runtimeConfigRevisions,
  runtimeConfigState,
  runtimeSecretVersions,
} from "../db/schema/index.ts";
import type { TestDb } from "../db/tests/setup.ts";
import { logger } from "../logging/index.ts";
import { createDeterministicHexFactory } from "../test-helpers/determinism/ids.ts";
import { waitFor } from "../test-helpers/determinism/wait.ts";
import {
  artifactReceipt,
  healthy,
  PROCESS_TEST_TIMEOUT_MS,
  processFixture,
} from "../test-helpers/engine-process.ts";

const hex = createDeterministicHexFactory(0xe619e);

async function snapshot(db: TestDb) {
  return {
    state: await db.db.select().from(runtimeConfigState),
    revisions: await db.db.select().from(runtimeConfigRevisions),
    secrets: await db.db.select().from(runtimeSecretVersions),
  };
}

test(
  "engine pins/registers before HTTP health and removes registration after graceful shutdown",
  async () => {
    const fixture = await processFixture("normal");
    try {
      const child = fixture.start();
      await healthy(fixture, child);
      const startupMs = child.elapsed();
      const ready = await fetch(`http://127.0.0.1:${fixture.port}/ready`, {
        signal: AbortSignal.timeout(1000),
      });
      expect(ready.status).toBe(200);
      expect(await ready.json()).toMatchObject({
        status: "ready",
        version: fixture.target.version,
        checks: { lifecycle: "pass", database: "pass" },
      });
      const [revision] = await fixture.db.db.select().from(runtimeConfigRevisions);
      expect(revision?.document).toMatchObject({
        server: { port: fixture.port },
        llm: { provider: "mock" },
        operations: { update_check_enabled: false },
      });
      const blocker = await fixture.db.pool.connect();
      let response: Response;
      try {
        await blocker.query("BEGIN");
        await blocker.query('LOCK TABLE "subkit"."api_keys" IN ACCESS EXCLUSIVE MODE');
        const request = fetch(`http://127.0.0.1:${fixture.port}/v1/workflows`, {
          headers: { authorization: `Bearer wf_live_${hex(24)}` },
          signal: AbortSignal.timeout(15000),
        }).then(
          (response) => ({ response }),
          (error: unknown) => ({ error }),
        );
        await waitFor(
          async () => {
            const waiting = await fixture.db.pool.query<{ waiting: boolean }>(
              `SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database() AND pid <> pg_backend_pid()
                AND wait_event_type = 'Lock' AND query LIKE '%"api_keys"%'
            ) AS waiting`,
            );
            return waiting.rows[0]?.waiting === true;
          },
          { tries: 250, sleepMs: 20, label: "engine HTTP authentication admitted under lock" },
        );
        child.child.kill("SIGTERM");
        await waitFor(() => child.logs().includes('"action":"shutdown.begin"'), {
          tries: 250,
          sleepMs: 20,
          label: "engine shutdown begins with HTTP handler pending",
        });
        expect(child.isRunning()).toBe(true);
        expect(child.logs()).not.toContain('"action":"shutdown.complete"');
        expect(
          await fixture.db.db
            .select()
            .from(runtimeConfigReplicas)
            .where(eq(runtimeConfigReplicas.instance_id, child.replicaId)),
        ).toHaveLength(1);
        await blocker.query("ROLLBACK");
        const result = await request;
        if ("error" in result) throw result.error;
        response = result.response;
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
      }
      expect(response.status).toBe(401);
      await response.arrayBuffer();
      const code = await child.exited();
      expect(code).toBe(0);
      expect(child.logs()).toContain('"action":"shutdown.complete"');
      expect(child.logs()).not.toContain('"action":"shutdown.replica_registration_retained"');
      expect(
        await fixture.db.db
          .select()
          .from(runtimeConfigReplicas)
          .where(eq(runtimeConfigReplicas.instance_id, child.replicaId)),
      ).toEqual([]);
      const before = await snapshot(fixture.db);
      const mismatch = fixture.start(hex(32), "fixture-engine-mismatch");
      expect(await mismatch.exited()).toBe(1);
      expect(mismatch.logs()).toContain("vault_master_key_mismatch");
      expect(mismatch.logs()).not.toContain('"action":"ready"');
      expect(await snapshot(fixture.db)).toEqual(before);
      expect(await fixture.db.db.select().from(runtimeConfigReplicas)).toEqual([]);
      await expect(
        fetch(`http://127.0.0.1:${fixture.port}/health`, { signal: AbortSignal.timeout(1000) }),
      ).rejects.toBeDefined();
      logger.info({
        module: "tests",
        action: "engine_process.normal_receipt",
        version: fixture.target.version,
        startup_ms: Math.round(startupMs),
        normal_exit: code,
        admitted_http_authentication_drained: true,
        registry_retained_until_http_release: true,
        mismatch_exit: 1,
        source_bun: fixture.target.kind === "source-bun",
        ...artifactReceipt(fixture.target),
      });
    } finally {
      await fixture.cleanup();
    }
  },
  PROCESS_TEST_TIMEOUT_MS,
);

test(
  "abrupt engine death preserves its owned registration for review",
  async () => {
    const fixture = await processFixture("abrupt");
    try {
      const child = fixture.start();
      await healthy(fixture, child);
      child.child.kill("SIGKILL");
      await child.exited();
      expect(child.logs()).not.toContain('"action":"shutdown.complete"');
      const rows = await fixture.db.db
        .select()
        .from(runtimeConfigReplicas)
        .where(eq(runtimeConfigReplicas.instance_id, child.replicaId));
      expect(rows).toHaveLength(1);
      logger.info({
        module: "tests",
        action: "engine_process.abrupt_receipt",
        version: fixture.target.version,
        registration_retained: true,
        source_bun: fixture.target.kind === "source-bun",
        ...artifactReceipt(fixture.target),
      });
    } finally {
      await fixture.cleanup();
    }
  },
  PROCESS_TEST_TIMEOUT_MS,
);
