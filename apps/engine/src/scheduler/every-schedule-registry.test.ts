import { expect, test } from "bun:test";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { type EveryScheduleDefinition, EveryScheduleRegistry } from "./every-schedule-registry.ts";

const uuid = createDeterministicUuidFactory(0xe7e1);
function definition(): EveryScheduleDefinition {
  return { schedule_id: uuid(), tenant_id: uuid(), workflow_id: uuid(), seconds: 2 };
}
function fixture() {
  const installed: string[] = [];
  const disposed: string[] = [];
  const registry = new EveryScheduleRegistry((value) => {
    installed.push(value.schedule_id);
    return () => disposed.push(value.schedule_id);
  });
  return { registry, installed, disposed };
}

test("partial discovery keeps every prior timer and unchanged definitions retain their cadence", async () => {
  const { registry, installed, disposed } = fixture();
  const first = definition();
  const second = definition();
  const initial = registry.begin();
  registry.observe(initial, first);
  registry.observe(initial, second);
  registry.finish(initial, true);
  expect(await registry.prune(initial, async () => null)).toBe(true);
  const partial = registry.begin();
  registry.observe(partial, first);
  registry.finish(partial, false);
  expect(await registry.prune(partial, async () => null)).toBe(true);
  expect(installed).toEqual([first.schedule_id, second.schedule_id]);
  expect(disposed).toEqual([]);
});

test("completed generations recheck unseen timers and do not remove newly eligible definitions", async () => {
  const { registry, disposed } = fixture();
  const first = definition();
  const second = definition();
  const initial = registry.begin();
  registry.observe(initial, first);
  registry.observe(initial, second);
  registry.finish(initial, true);
  await registry.prune(initial, async () => null);
  const next = registry.begin();
  registry.finish(next, true);
  const checked: string[] = [];
  await registry.prune(next, async (value) => {
    checked.push(value.schedule_id);
    return value.schedule_id === first.schedule_id ? value : null;
  });
  expect(checked).toEqual([first.schedule_id, second.schedule_id]);
  expect(disposed).toEqual([second.schedule_id]);
});

test("pruning has bounded finite continuation and transient reads retain registrations", async () => {
  const { registry, disposed } = fixture();
  const initial = registry.begin();
  for (let index = 0; index < 131; index++) registry.observe(initial, definition());
  registry.finish(initial, true);
  while (!(await registry.prune(initial, async () => null))) {}
  const next = registry.begin();
  registry.finish(next, true);
  let calls = 0;
  const inspect = async () => {
    calls++;
    if (calls === 1) throw new Error("fixture_metadata_unavailable");
    return null;
  };
  expect(await registry.prune(next, inspect)).toBe(false);
  expect(calls).toBe(64);
  expect(disposed).toHaveLength(63);
  expect(await registry.prune(next, inspect)).toBe(false);
  expect(calls).toBe(128);
  expect(await registry.prune(next, inspect)).toBe(true);
  expect(calls).toBe(131);
  expect(disposed).toHaveLength(130);
});

test("stopping during a prune read never reinstalls a timer after all handles are cleared", async () => {
  const { registry, installed, disposed } = fixture();
  const value = definition();
  const initial = registry.begin();
  registry.observe(initial, value);
  registry.finish(initial, true);
  await registry.prune(initial, async () => null);
  const next = registry.begin();
  registry.finish(next, true);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const pending = registry.prune(next, async () => {
    entered.resolve();
    await release.promise;
    return { ...value, seconds: 3 };
  });
  await entered.promise;
  registry.clear();
  release.resolve();
  await pending;
  expect(installed).toEqual([value.schedule_id]);
  expect(disposed).toEqual([value.schedule_id]);
  registry.observe(next, value);
  expect(installed).toHaveLength(1);
});
