import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CATALOGS, type TranslationKey } from "@/lib/i18n";
import { RUN_STATE_WORDS_DE, RUN_STATE_WORDS_EN, type RunStateWord } from "./task-run-words";

const STATES = Object.keys(RUN_STATE_WORDS_EN) as RunStateWord[];
const PREFIXES = ["tasks.state.", "chat.taskRun.state.", "audit.task.state."];

describe("one vocabulary for run states", () => {
  test("the words are the agreed ones in both languages", () => {
    expect(RUN_STATE_WORDS_DE).toEqual({
      running: "läuft",
      waiting: "wartet auf dich",
      sleeping: "schläft",
      result_ready: "Ergebnis liegt vor",
      completed: "erledigt",
      aborted: "abgebrochen",
      failed: "fehlgeschlagen",
    });
    expect(RUN_STATE_WORDS_EN).toEqual({
      running: "running",
      waiting: "waiting for you",
      sleeping: "sleeping",
      result_ready: "result ready",
      completed: "done",
      aborted: "aborted",
      failed: "failed",
    });
  });

  test("the task pages, the run line in chat and the audit trail use them", () => {
    for (const prefix of PREFIXES)
      for (const state of STATES) {
        const key = `${prefix}${state}` as TranslationKey;
        expect(CATALOGS.en[key]).toBe(RUN_STATE_WORDS_EN[state]);
        expect(CATALOGS.de[key]).toBe(RUN_STATE_WORDS_DE[state]);
      }
  });

  test("the command line prints the same English words", () => {
    const source = readFileSync(
      resolve(import.meta.dir, "../../../sk/src/commands/tasks.ts"),
      "utf8",
    );
    const block = source.match(/export const RUN_STATE_WORDS[^=]*= \{([^}]*)\}/)?.[1] ?? "";
    const words = Object.fromEntries(
      [...block.matchAll(/(\w+): "([^"]*)"/g)].map((match) => [match[1], match[2]]),
    );
    expect(words).toEqual({ ...RUN_STATE_WORDS_EN });
  });
});
