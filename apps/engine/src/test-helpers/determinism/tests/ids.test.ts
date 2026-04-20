import { describe, expect, it } from "bun:test";
import {
  createDeterministicHexFactory,
  createDeterministicIdFactory,
  createDeterministicSequenceId,
  createDeterministicUuidFactory,
  resetAllDeterministicIds,
} from "../ids.ts";

describe("ids", () => {
  it("createDeterministicIdFactory mints monotonically increasing ids", () => {
    const f = createDeterministicIdFactory("wf");
    expect(f.next()).toBe("wf-000000");
    expect(f.next()).toBe("wf-000001");
    expect(f.next("exec")).toBe("wf-exec-000002");
    expect(f.count()).toBe(3);
  });

  it("factory reset() returns to zero", () => {
    const f = createDeterministicIdFactory("t");
    f.next();
    f.next();
    f.reset();
    expect(f.next()).toBe("t-000000");
  });

  it("two factories with same prefix are independent", () => {
    const a = createDeterministicIdFactory("x");
    const b = createDeterministicIdFactory("x");
    a.next();
    a.next();
    expect(b.next()).toBe("x-000000");
  });

  it("createDeterministicSequenceId uses a shared counter", () => {
    resetAllDeterministicIds();
    const one = createDeterministicSequenceId("wf", "a");
    const two = createDeterministicSequenceId("wf", "a");
    expect(one).toBe("wf-a-0000");
    expect(two).toBe("wf-a-0001");
  });

  it("resetAllDeterministicIds resets the shared counter", () => {
    resetAllDeterministicIds();
    createDeterministicSequenceId("x", 1);
    createDeterministicSequenceId("x", 1);
    resetAllDeterministicIds();
    expect(createDeterministicSequenceId("x", 1)).toBe("x-1-0000");
  });

  it("hex factory is reproducible given the same seed", () => {
    const a = createDeterministicHexFactory(42);
    const b = createDeterministicHexFactory(42);
    expect(a(8)).toBe(b(8));
    expect(a(8)).toBe(b(8));
  });

  it("hex factory diverges for different seeds", () => {
    const a = createDeterministicHexFactory(1);
    const b = createDeterministicHexFactory(2);
    expect(a(8)).not.toBe(b(8));
  });

  it("uuid factory emits v4-shaped strings", () => {
    const uuid = createDeterministicUuidFactory(7);
    const id = uuid();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuid()).not.toBe(id);
  });

  it("uuid factory is reproducible given the same seed", () => {
    const a = createDeterministicUuidFactory(9);
    const b = createDeterministicUuidFactory(9);
    expect(a()).toBe(b());
    expect(a()).toBe(b());
  });
});
