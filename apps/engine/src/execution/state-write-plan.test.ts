import { expect, test } from "bun:test";
import { planStateWrite, stateValueKind } from "./state-write-plan.ts";

test.each(["data.0.id", "data[0].id", "data[first].id", "data[last].id"])(
  "state writes resolve %s and preserve missing watermarks",
  (path) => {
    expect(planStateWrite({ data: [{ id: "ch_new" }] }, path)).toEqual({
      write: true,
      value: "ch_new",
    });
    const missing = planStateWrite({ data: [] }, path);
    expect(missing).toEqual({ write: false });
    expect(stateValueKind(missing)).toBe("skipped");
    expect(planStateWrite({ data: [{ id: null }] }, path)).toEqual({
      write: true,
      value: null,
    });
  },
);
