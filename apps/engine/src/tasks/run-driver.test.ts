import { describe, expect, test } from "bun:test";
import { taskRunTurnFailure } from "./run-driver.ts";

const NOW = new Date("2026-11-19T08:00:00.000Z");
const failure = (code: string, retry_at?: string) =>
  ({ code, message: "x", at: NOW.toISOString(), ...(retry_at ? { retry_at } : {}) }) as never;

describe("task run driver", () => {
  test("only provider throttling carries a retry time, a stated one in the future wins", () => {
    expect(
      taskRunTurnFailure(failure("llm_spend_limit_reached", "2026-11-19T09:00:00.000Z"), NOW),
    ).toEqual({ code: "llm_spend_limit_reached", retry_at: null });
    expect(taskRunTurnFailure(failure("internal"), NOW)).toEqual({
      code: "internal",
      retry_at: null,
    });
    expect(
      taskRunTurnFailure(failure("llm_provider_limited", "2026-11-19T09:00:00.000Z"), NOW),
    ).toEqual({ code: "llm_provider_limited", retry_at: new Date("2026-11-19T09:00:00.000Z") });
    for (const stated of [undefined, "2026-11-19T07:00:00.000Z", "soon"])
      expect(taskRunTurnFailure(failure("llm_provider_limited", stated), NOW)).toEqual({
        code: "llm_provider_limited",
        retry_at: new Date("2026-11-19T08:01:00.000Z"),
      });
  });
});
