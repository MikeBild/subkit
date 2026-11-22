import { describe, expect, test } from "bun:test";
import {
  LEDGER_RETENTION_MS,
  ledgerForm,
  markDelivered,
  parseLedger,
  prune,
  recall,
  recallEntry,
  remember,
  replayVerdict,
  undeliveredIds,
} from "./runner-ledger.ts";
import { command } from "./runner-queue.fixture.ts";

const NOW = 1_000_000_000_000;
const done = { status: "done" as const, output: { entries: 2 }, evidence: {} };

describe("runner ledger", () => {
  test("remembers a result and answers a repeated command id with it", () => {
    const ledger = remember([], "a", done, NOW);
    expect(recall(ledger, "a")).toEqual(done);
    expect(recall(ledger, "b")).toBeNull();
  });

  test("a new result waits for delivery until the server acknowledged it", () => {
    const ledger = remember(remember([], "a", done, NOW), "b", done, NOW + 1);
    expect(undeliveredIds(ledger)).toEqual(["a", "b"]);
    const acked = markDelivered(ledger, "a");
    expect(undeliveredIds(acked)).toEqual(["b"]);
    expect(recall(acked, "a")).toEqual(done);
    expect(parseLedger(JSON.parse(JSON.stringify(acked)))).toEqual(acked);
  });

  test("keeps the first result of a command", () => {
    const ledger = remember(remember([], "a", done, NOW), "a", { status: "stopped" }, NOW + 1);
    expect(ledger).toHaveLength(1);
    expect(recall(ledger, "a")).toEqual(done);
  });

  test("drops entries older than seven days", () => {
    const ledger = remember([], "a", done, NOW);
    expect(prune(ledger, NOW + LEDGER_RETENTION_MS - 1)).toHaveLength(1);
    expect(prune(ledger, NOW + LEDGER_RETENTION_MS)).toHaveLength(0);
    expect(remember(ledger, "b", done, NOW + LEDGER_RETENTION_MS).map((e) => e.command_id)).toEqual(
      ["b"],
    );
  });

  test("parses only valid entries from disk", () => {
    expect(parseLedger(null)).toEqual([]);
    expect(parseLedger({})).toEqual([]);
    expect(
      parseLedger([
        { command_id: "a", result: done, finished_at: NOW },
        { command_id: "b", result: { status: "unknown" }, finished_at: NOW },
        { command_id: "", result: done, finished_at: NOW },
      ]),
    ).toEqual([{ command_id: "a", result: done, finished_at: NOW }]);
  });

  test("never keeps the text of a read, only its size, hash and versions", () => {
    const read = command("r", { kind: "files.read_text", args: { target: { absolute: "/a" } } });
    const result = {
      status: "done" as const,
      output: { text: "secret contents", size: 15, sha256: "f".repeat(64) },
      evidence: { before_version: "b", after_version: "a" },
    };
    const ledger = remember([], "r", result, NOW, read);
    expect(JSON.stringify(ledger)).not.toContain("secret contents");
    expect(recallEntry(ledger, "r")).toEqual({
      command_id: "r",
      result: {
        status: "done",
        output: { size: 15, sha256: "f".repeat(64) },
        evidence: result.evidence,
      },
      replay: read,
      finished_at: NOW,
      undelivered: true,
    });
    expect(parseLedger(JSON.parse(JSON.stringify(ledger)))).toEqual(ledger);
  });

  test("keeps other results unchanged and without a replay", () => {
    const list = command("l", { kind: "files.list" });
    expect(ledgerForm(list, done)).toEqual({ result: done });
    const refusal = { status: "refused" as const, code: "stale" as const, detail: "x" };
    expect(ledgerForm(command("r", { kind: "files.read_text" }), refusal)).toEqual({
      result: refusal,
    });
    expect(ledgerForm(null, done)).toEqual({ result: done });
  });

  test("a re-read returns the fresh text only while the version is unchanged", () => {
    const stored = { status: "done" as const, output: {}, evidence: { after_version: "v1" } };
    const fresh = {
      status: "done" as const,
      output: { text: "x" },
      evidence: { after_version: "v1" },
    };
    expect(replayVerdict(stored, fresh)).toEqual(fresh);
    expect(replayVerdict(stored, { ...fresh, evidence: { after_version: "v2" } })).toMatchObject({
      status: "refused",
      code: "stale",
    });
    expect(replayVerdict(stored, { ...fresh, evidence: {} })).toMatchObject({ code: "stale" });
    const refusal = { status: "refused" as const, code: "outside_allowance" as const, detail: "x" };
    expect(replayVerdict(stored, refusal)).toEqual(refusal);
  });
});
