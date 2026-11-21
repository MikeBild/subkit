import { describe, expect, it } from "bun:test";
import type { SpendLimit } from "@/api/spend-limit";
import { spendIntent, spendPanel, spendSettingMode, usdFormatter } from "./spend-model";

const base: SpendLimit = {
  currency: "USD",
  month: "2026-11",
  timezone: "Europe/Berlin",
  from: "2026-10-31T23:00:00.000Z",
  to: "2026-11-30T23:00:00.000Z",
  limit_usd: 50,
  spent_usd: 12.4,
  unpriced_calls: 0,
  share: 0.248,
  state: "ok",
  countable: true,
  warning_share: 0.8,
  run_notice_usd: 5,
  choices: [20, 50, 200, 0],
  limit_chosen: true,
  can_change: true,
};

describe("spend panel", () => {
  it("shows the share of the limit and lets an admin raise it", () => {
    expect(spendPanel(base)).toMatchObject({
      state: "ok",
      pct: 24,
      tone: "success",
      canRaise: true,
      canContinue: false,
      choices: [20, 50, 200, 0],
    });
  });

  it("at the limit an admin may continue, and only higher limits are offered", () => {
    const reached = {
      ...base,
      spent_usd: 30,
      share: 1.5,
      limit_usd: 20,
      state: "reached" as const,
    };
    expect(spendPanel(reached)).toMatchObject({
      tone: "danger",
      canContinue: true,
      choices: [50, 200, 0],
    });
    expect(spendPanel({ ...reached, can_change: false })).toMatchObject({
      canRaise: false,
      canContinue: false,
    });
  });

  it("no dollar figure without a USD price basis", () => {
    expect(spendPanel({ ...base, countable: false })).toBeNull();
    expect(spendPanel(undefined)).toBeNull();
  });

  it("only someone who may change it gets an editable budget, members read it", () => {
    expect(spendSettingMode(base)).toBe("edit");
    expect(spendSettingMode({ can_change: false })).toBe("read");
    expect(spendSettingMode(undefined)).toBe("read");
  });

  it("reads the attention link as an intent", () => {
    expect(spendIntent("?spend=raise")).toBe("raise");
    expect(spendIntent("?spend=continue")).toBe("continue");
    expect(spendIntent("?spend=other")).toBeNull();
  });

  it("formats dollars as $ in both languages", () => {
    expect(usdFormatter("en")(50)).toBe("$50");
    expect(usdFormatter("de")(12.4).replace(/\s/g, " ")).toBe("12,4 $");
  });
});
