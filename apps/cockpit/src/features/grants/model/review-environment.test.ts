import { expect, test } from "bun:test";
import { reviewEnvironment } from "@/features/grants/model/review-environment";

const NOW = new Date("2026-09-23T10:00:00.000Z");
const live = (env: string) => ({
  execution_environment: env,
  revoked_at: null,
  valid_until: "2026-10-23T10:00:00.000Z",
});

test("a live approval decides, even with no held schedule", () => {
  expect(reviewEnvironment([live("prod")], undefined, NOW)).toBe("prod");
});

test("a held schedule is used only when no approval says otherwise", () => {
  expect(reviewEnvironment([], { execution_mode: "prod" }, NOW)).toBe("prod");
  expect(reviewEnvironment([live("prod")], { execution_mode: "dev" }, NOW)).toBe("prod");
});

test("revoked and expired approvals are skipped for a live one", () => {
  const approvals = [
    { ...live("dev"), revoked_at: "2026-09-01T00:00:00.000Z" },
    { ...live("dev"), valid_until: "2026-09-02T00:00:00.000Z" },
    live("prod"),
  ];
  expect(reviewEnvironment(approvals, undefined, NOW)).toBe("prod");
});

test("a lapsed approval still beats guessing development", () => {
  const expired = [{ ...live("prod"), valid_until: "2026-09-02T00:00:00.000Z" }];
  expect(reviewEnvironment(expired, undefined, NOW)).toBe("prod");
  const revoked = [{ ...live("prod"), revoked_at: "2026-09-02T00:00:00.000Z" }];
  expect(reviewEnvironment(revoked, undefined, NOW)).toBe("prod");
});

test("with nothing to go on it stays development", () => {
  expect(reviewEnvironment([], undefined, NOW)).toBe("dev");
  expect(reviewEnvironment(undefined, undefined, NOW)).toBe("dev");
  expect(reviewEnvironment([{ execution_environment: "staging" }], undefined, NOW)).toBe("dev");
  expect(reviewEnvironment([], { execution_mode: "something" }, NOW)).toBe("dev");
});
