import { expect, test } from "bun:test";
import { translate } from "@/lib/i18n";
import { statusLabel } from "@/lib/status-label";
import { runListState } from "./runs-model";

test("a run waiting for the AI budget reads as such, everything else keeps its state", () => {
  expect(runListState({ status: "queued", waiting_reason: "budget" })).toBe("waiting_budget");
  expect(runListState({ status: "queued", waiting_reason: null })).toBe("queued");
  expect(runListState({ status: "succeeded" })).toBe("succeeded");
  expect(statusLabel((key) => translate("de", key), "waiting_budget")).toBe("Wartet auf Budget");
});
