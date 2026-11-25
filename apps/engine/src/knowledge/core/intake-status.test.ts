import { describe, expect, test } from "bun:test";
import { canMoveIntakeItem, intakeItemSources, intakeProposalSources } from "./intake-status.ts";

describe("intake proposal transitions", () => {
  test("a draft goes stale, is confirmed or rejected, or gets a new revision", () => {
    expect(intakeProposalSources("stale")).toEqual(["draft"]);
    expect(intakeProposalSources("confirmed")).toEqual(["draft"]);
    expect(intakeProposalSources("rejected")).toEqual(["draft"]);
  });

  test("a revision turns a draft or a stale proposal back into a draft", () => {
    expect(intakeProposalSources("draft")).toEqual(["draft", "stale"]);
  });
});

describe("intake item transitions", () => {
  test("an admitted item keeps its processing state", () => {
    expect(canMoveIntakeItem("admitted", "collected")).toBe(false);
    expect(canMoveIntakeItem("admitted", "reviewing")).toBe(false);
    expect(canMoveIntakeItem("admitted", "discarded")).toBe(false);
    expect(canMoveIntakeItem("admitted", "admitted")).toBe(true);
  });

  test("open and discarded items move between the open states and the bin", () => {
    expect(canMoveIntakeItem("collected", "reviewing")).toBe(true);
    expect(canMoveIntakeItem("reviewing", "collected")).toBe(true);
    expect(canMoveIntakeItem("discarded", "collected")).toBe(true);
    expect(canMoveIntakeItem("reviewing", "discarded")).toBe(true);
  });

  test("a confirmation admits open or already admitted items", () => {
    expect(intakeItemSources("admitted")).toEqual(["collected", "reviewing", "admitted"]);
    expect(intakeItemSources("reviewing")).toEqual(["collected", "reviewing", "discarded"]);
  });
});
