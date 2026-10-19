import { expect, test } from "bun:test";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import {
  beginTenantWork,
  tenantWorkInFlight,
  tenantWorkSnapshot,
  waitForTenantWorkDrain,
  withTenantWork,
} from "./tenant-work.ts";

const uuid = createDeterministicUuidFactory(0x71ee010);

test("work tracking lasts until operation settles and release is idempotent", async () => {
  const tenant = uuid();
  let finish: (() => void) | undefined;
  const running = withTenantWork(
    tenant,
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  expect(tenantWorkSnapshot(tenant).in_flight).toBe(1);
  const release = beginTenantWork(tenant);
  expect(tenantWorkSnapshot(tenant).in_flight).toBe(2);
  release();
  release();
  expect(tenantWorkSnapshot(tenant).in_flight).toBe(1);
  finish?.();
  await running;
  expect(tenantWorkSnapshot(tenant).in_flight).toBe(0);
  await expect(
    withTenantWork(tenant, async () => {
      throw new Error("synthetic failure");
    }),
  ).rejects.toThrow("synthetic failure");
  expect(tenantWorkSnapshot(tenant).in_flight).toBe(0);
});

test("shutdown count includes unsettled work in every tenant", () => {
  const before = tenantWorkInFlight();
  const first = beginTenantWork(uuid());
  const second = beginTenantWork(uuid());
  try {
    expect(tenantWorkInFlight()).toBe(before + 2);
    first();
    expect(tenantWorkInFlight()).toBe(before + 1);
    first();
    expect(tenantWorkInFlight()).toBe(before + 1);
  } finally {
    first();
    second();
  }
  expect(tenantWorkInFlight()).toBe(before);
});

test("drain observers wait for actual work across tenants and newly nested work", async () => {
  const first = beginTenantWork(uuid());
  const second = beginTenantWork(uuid());
  let drained = 0;
  const firstObserver = waitForTenantWorkDrain().then(() => {
    drained++;
  });
  const secondObserver = waitForTenantWorkDrain().then(() => {
    drained++;
  });
  const nested = beginTenantWork(uuid());
  try {
    first();
    second();
    await Promise.resolve();
    expect(drained).toBe(0);
    expect(tenantWorkInFlight()).toBe(1);
    nested();
    await firstObserver;
    await secondObserver;
    expect(drained).toBe(2);
    await waitForTenantWorkDrain();
    const later = beginTenantWork(uuid());
    let laterDrained = false;
    const laterObserver = waitForTenantWorkDrain().then(() => {
      laterDrained = true;
    });
    await Promise.resolve();
    expect(laterDrained).toBe(false);
    later();
    await laterObserver;
    expect(laterDrained).toBe(true);
  } finally {
    first();
    second();
    nested();
    await firstObserver;
    await secondObserver;
  }
});
