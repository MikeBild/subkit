import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { webhooksInbound } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { waitFor } from "../../../test-helpers/determinism/wait.ts";
import {
  bindFromWorkflow,
  createInbound,
  InboundSlugTakenError,
  inboundSlugCandidate,
} from "../service.ts";
import { seedTenantWorkflow } from "./setup.ts";

let testDb: TestDb;
let holder: { tenantId: string; workflowId: string };
let claimant: { tenantId: string; workflowId: string };

const unsignedTrigger = {
  kind: "webhook" as const,
  source: "generic",
  events: [],
  verify: "none" as const,
};

beforeAll(async () => {
  testDb = await createTestDb("wh-inbound-slug-claim");
  holder = await seedTenantWorkflow(testDb.db, "holder", "holder-flow");
  claimant = await seedTenantWorkflow(testDb.db, "claimant", "claimant-flow");
});

afterAll(async () => {
  await testDb.cleanup();
});

async function holdUncommitted(slug: string) {
  let release!: () => void;
  let markInserted!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inserted = new Promise<void>((resolve) => {
    markInserted = resolve;
  });
  const committed = testDb.db.transaction(async (tx) => {
    await tx.insert(webhooksInbound).values({
      tenant_id: holder.tenantId,
      slug,
      workflow_id: holder.workflowId,
      verifier: "standard",
      secret_ciphertext: Buffer.from("held"),
      secret_iv: Buffer.from("held"),
      secret_auth_tag: Buffer.from("held"),
    });
    markInserted();
    await released;
  });
  await inserted;
  return { release, committed };
}

async function someoneWaitsOnALock(): Promise<boolean> {
  const result = await testDb.db.execute<{ waiting: number }>(sql`
    SELECT count(*)::int AS waiting FROM pg_stat_activity
     WHERE datname = current_database() AND wait_event_type = 'Lock'
  `);
  return (result.rows[0]?.waiting ?? 0) > 0;
}

describe("claiming a globally unique inbound hook slug", () => {
  test("a slug another tenant claims concurrently gives the binding the tenant's own form", async () => {
    const held = await holdUncommitted("wf-race-insert");
    const binding = bindFromWorkflow(
      {
        tenant_id: claimant.tenantId,
        workflow_id: claimant.workflowId,
        workflow_slug: "race-insert",
        trigger: unsignedTrigger,
        actor_id: null,
      },
      testDb.db,
    );
    await waitFor(someoneWaitsOnALock, { label: "binding waits on the held slug", sleepMs: 10 });
    held.release();
    await held.committed;

    const bound = await binding;
    expect(bound.status).toBe("created");
    expect(bound.row.slug).toBe(inboundSlugCandidate("wf-race-insert", claimant.tenantId, 1));
  });

  test("a rename racing another tenant's claim leaves the caller's transaction usable", async () => {
    const held = await holdUncommitted("wf-race-rename");
    const renaming = testDb.db.transaction(async (outer) => {
      const bound = await bindFromWorkflow(
        {
          tenant_id: claimant.tenantId,
          workflow_id: claimant.workflowId,
          workflow_slug: "race-rename",
          trigger: unsignedTrigger,
          actor_id: null,
        },
        outer,
      );
      const [stored] = await outer
        .select({ slug: webhooksInbound.slug })
        .from(webhooksInbound)
        .where(
          and(
            eq(webhooksInbound.tenant_id, claimant.tenantId),
            eq(webhooksInbound.id, bound.row.id),
          ),
        );
      return { bound, stored };
    });
    await waitFor(someoneWaitsOnALock, { label: "rename waits on the held slug", sleepMs: 10 });
    held.release();
    await held.committed;

    const { bound, stored } = await renaming;
    expect(bound.status).toBe("updated");
    expect(bound.row.slug).toBe(inboundSlugCandidate("wf-race-rename", claimant.tenantId, 1));
    expect(stored?.slug).toBe(bound.row.slug);
  });

  test("a chosen slug that is already in use is refused without naming its holder", async () => {
    await createInbound(
      {
        tenant_id: holder.tenantId,
        actor_id: null,
        slug: "orders-intake",
        workflow_id: holder.workflowId,
        verifier: "standard",
        secret: "holder-secret",
      },
      testDb.db,
    );
    for (const tenant of [claimant, holder]) {
      const refused = await createInbound(
        {
          tenant_id: tenant.tenantId,
          actor_id: null,
          slug: "orders-intake",
          workflow_id: tenant.workflowId,
          verifier: "standard",
          secret: "second-secret",
        },
        testDb.db,
      ).then(
        () => null,
        (err: unknown) => err,
      );
      expect(refused).toBeInstanceOf(InboundSlugTakenError);
      const message = refused instanceof Error ? refused.message : "";
      expect(message).not.toContain(holder.tenantId);
      expect(message).not.toContain(holder.workflowId);
    }
  });
});
