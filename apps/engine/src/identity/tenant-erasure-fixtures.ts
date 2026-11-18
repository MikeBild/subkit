import { expect } from "bun:test";
import { eq } from "drizzle-orm";
import type { FindJobsOptions, JobWithMetadata } from "pg-boss";
import { tenants } from "../db/schema/index.ts";
import type { HttpTestServer } from "../http/tests/setup.ts";
import type { TenantErasureQueue } from "../queue/tenant-erasure.ts";
import { reserveHostedObject, retainHostedObject } from "../storage/hosted-objects.ts";
import { MemoryObjectStore } from "../storage/object-store.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { TEST_WORKSPACE_REGISTRATION } from "../test-helpers/workspace-registration.ts";
import { provisionSelfServiceTenant } from "./self-service.ts";

export function queue(activeTenant?: string): TenantErasureQueue & { canceled: number } {
  let active = !!activeTenant;
  return {
    canceled: 0,
    async getQueues() {
      return [{ name: "execution.run" }];
    },
    async getSchedules() {
      return [];
    },
    async findJobs<T>(_name: string, options?: FindJobsOptions) {
      return (
        active &&
        options?.data &&
        (options.data as { tenant_id?: string }).tenant_id === activeTenant
          ? [{ id: "exact-job", state: "active", data: { tenant_id: activeTenant } }]
          : []
      ) as JobWithMetadata<T>[];
    },
    async cancel(_name, ids) {
      expect(ids).toEqual(["exact-job"]);
      this.canceled += 1;
      active = false;
    },
    async deleteJob() {},
    async unschedule() {},
  };
}

export function tenantErasureFixtures(state: { readonly ctx: HttpTestServer }) {
  const nextUuid = createDeterministicUuidFactory(89712);

  async function fixture(
    name: string,
    due = true,
    trackOffload = false,
    scope: Pick<HttpTestServer, "db"> = state.ctx,
  ) {
    const owned = await provisionSelfServiceTenant(
      {
        issuer_url: "https://erase.example.test",
        subject: name,
        email: `${name}@example.test`,
        email_verified: true,
      },
      TEST_WORKSPACE_REGISTRATION,
      scope.db,
    );
    const objects = new MemoryObjectStore();
    const objectKey = `offload/${owned.tenant.id}/${nextUuid()}.json`;
    const reservation = trackOffload
      ? await reserveHostedObject(scope.db, owned.tenant.id, objectKey, 7)
      : null;
    await objects.put(`${owned.tenant.id}/file`, Buffer.from("private"));
    await objects.put(objectKey, Buffer.from("private"));
    if (reservation) await retainHostedObject(scope.db, owned.tenant.id, reservation);
    await scope.db
      .update(tenants)
      .set({
        status: "pending_deletion",
        deletion_requested_at: new Date(getTestNow() - 8 * 86_400_000),
        deletion_scheduled_for: new Date(getTestNow() + (due ? -1 : 1) * 86_400_000),
      })
      .where(eq(tenants.id, owned.tenant.id));
    return { owned, objects };
  }

  return { fixture, nextUuid };
}
