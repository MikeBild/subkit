import { describe, expect, test } from "bun:test";
import {
  boundaryCounts,
  currentApproval,
  graphState,
  stepRowState,
  stepRows,
} from "./workflow-model";

const step = (over: Partial<Parameters<typeof stepRows>[0][number]> = {}) => ({
  id: "fetch",
  kind: "request",
  name: null,
  connector: "Gmail",
  target: "messages",
  writes: false,
  lastStatus: null,
  ...over,
});

describe("workflow step rows", () => {
  test("a reading request lists its service under reads", () => {
    expect(stepRows([step()])[0]).toEqual({
      id: "fetch",
      label: "fetch",
      reads: ["Gmail: messages"],
      writes: [],
      kind: "read",
      state: "pending",
    });
  });

  test("an unknown write flag counts as a write, never as a read", () => {
    const [row] = stepRows([step({ writes: null, name: "Send" })]);
    expect(row).toMatchObject({
      label: "Send",
      reads: [],
      writes: ["Gmail: messages"],
      kind: "write",
    });
  });

  test("a step without a connector computes and touches no service", () => {
    expect(stepRows([step({ connector: null, kind: "transform" })])[0]).toMatchObject({
      reads: [],
      writes: [],
      kind: "compute",
    });
    expect(stepRows([step({ target: null })])[0]?.reads).toEqual(["Gmail"]);
  });

  test("the last run's step status decides the graph state", () => {
    expect(stepRowState("succeeded")).toBe("done");
    expect(stepRowState("running")).toBe("active");
    expect(stepRowState("failed")).toBe("failed");
    expect(stepRowState(null)).toBe("pending");
    expect(stepRowState("strange")).toBe("pending");
    expect(graphState("failed")).toBe("active");
    expect(graphState("done")).toBe("done");
    expect(graphState("pending")).toBe("pending");
  });

  test("the boundary counts distinct reads, writes and services", () => {
    const rows = stepRows([
      step(),
      step({ id: "again" }),
      step({ id: "send", writes: true, target: "send" }),
      step({ id: "crm", connector: "HubSpot", target: "contacts" }),
    ]);
    expect(boundaryCounts(rows)).toEqual({ reads: 2, writes: 1, services: 2 });
  });
});

describe("current approval", () => {
  const authority = (over: Record<string, unknown> = {}) => ({
    state: "approved",
    revoked_at: null,
    superseded_by: null,
    execution_environment: "prod" as const,
    valid_until: null,
    created_by: "Lena",
    created_at: "2026-11-01T00:00:00Z",
    reserved_runs: 3,
    max_runs: 10,
    ...over,
  });

  test("takes the newest live approval with its runs used", () => {
    const facts = currentApproval([
      authority(),
      authority({ created_at: "2026-11-10T00:00:00Z", reserved_runs: 1, max_runs: null }),
      authority({ created_at: "2026-11-20T00:00:00Z", state: "revoked" }),
    ]);
    expect(facts).toMatchObject({ environment: "prod", used: 1, maxRuns: null });
  });

  test("has none without a live approval", () => {
    expect(currentApproval([authority({ state: "expired" })])).toBeNull();
    expect(currentApproval(null)).toBeNull();
  });
});
