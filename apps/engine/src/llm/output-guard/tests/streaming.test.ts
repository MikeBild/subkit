// Unit tests for the streaming output-guard short-circuit.

import { describe, expect, it } from "bun:test";

import { runOutputGuardStream } from "../index.ts";
import type { Scanner, ScannerContext, Violation } from "../types.ts";

function scanner(id: string, behavior: "noop" | "violate" | "throw"): Scanner {
  return {
    id,
    scan(text: string, _ctx: ScannerContext): Violation[] {
      if (behavior === "throw") throw new Error("boom");
      if (behavior === "violate") {
        return [
          {
            kind: `${id}.test_violation`,
            message: `from ${id}`,
            span: { start: 0, end: text.length },
          },
        ];
      }
      return [];
    },
  };
}

describe("runOutputGuardStream", () => {
  it("returns no violations when no scanner fires", () => {
    const v = runOutputGuardStream(
      "hello world",
      {},
      {
        scanners: [scanner("a", "noop"), scanner("b", "noop")],
        mode: "soft",
      },
    );
    expect(v).toEqual([]);
  });

  it("short-circuits after the first scanner that finds a violation", () => {
    const calls: string[] = [];
    const probing: Scanner = {
      id: "probe",
      scan() {
        calls.push("probe");
        return [];
      },
    };
    const violating: Scanner = {
      id: "violator",
      scan(text: string) {
        calls.push("violator");
        return [
          {
            kind: "violator.bad",
            message: "bad",
            span: { start: 0, end: text.length },
          },
        ];
      },
    };
    const tail: Scanner = {
      id: "tail",
      scan() {
        calls.push("tail");
        return [];
      },
    };
    const v = runOutputGuardStream(
      "paragraph",
      {},
      {
        scanners: [probing, violating, tail],
        mode: "soft",
      },
    );
    expect(v.length).toBe(1);
    expect(v[0]?.kind).toBe("violator.bad");
    expect(calls).toEqual(["probe", "violator"]); // tail never ran
  });

  it("treats a thrown scanner as a no-op (does not crash drain, does not short-circuit)", () => {
    const calls: string[] = [];
    const throwing: Scanner = {
      id: "boom",
      scan() {
        calls.push("boom");
        throw new Error("bad scanner");
      },
    };
    const violator: Scanner = {
      id: "v",
      scan(text: string) {
        calls.push("v");
        return [
          {
            kind: "v.fired",
            message: "ok",
            span: { start: 0, end: text.length },
          },
        ];
      },
    };
    const v = runOutputGuardStream(
      "hello",
      {},
      {
        scanners: [throwing, violator],
        mode: "soft",
      },
    );
    expect(v.length).toBe(1);
    expect(v[0]?.kind).toBe("v.fired");
    expect(calls).toEqual(["boom", "v"]);
  });

  it("returns [] in `off` mode without invoking any scanner", () => {
    const calls: string[] = [];
    const probing: Scanner = {
      id: "probe",
      scan() {
        calls.push("probe");
        return [];
      },
    };
    const v = runOutputGuardStream("hello", {}, { scanners: [probing], mode: "off" });
    expect(v).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("handles empty paragraph text without invoking scanners", () => {
    const calls: string[] = [];
    const probing: Scanner = {
      id: "probe",
      scan() {
        calls.push("probe");
        return [];
      },
    };
    const v = runOutputGuardStream("", {}, { scanners: [probing], mode: "soft" });
    expect(v).toEqual([]);
    expect(calls).toEqual([]);
  });
});
