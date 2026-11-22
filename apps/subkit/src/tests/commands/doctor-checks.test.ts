import { describe, expect, test } from "bun:test";
import {
  configCheck,
  reachabilityCheck,
  updateChannelCheck,
  worst,
} from "../../commands/doctor-checks.ts";

const CONFIG = {
  path: "~/.subkit/config.json",
  exists: true,
  parses: true,
  profile: "default",
  profileFound: true,
};

describe("config check", () => {
  test("names the config path and profile", () => {
    expect(configCheck(CONFIG)).toEqual({
      name: "config",
      status: "ok",
      detail: "~/.subkit/config.json profile=default",
    });
  });

  test("a broken file blocks, a missing file or profile warns", () => {
    expect(configCheck({ ...CONFIG, parses: false }).status).toBe("blocked");
    expect(configCheck({ ...CONFIG, exists: false }).status).toBe("warn");
    const missing = configCheck({ ...CONFIG, profile: "prod", profileFound: false });
    expect(missing.status).toBe("warn");
    expect(missing.detail).toContain('"prod"');
  });
});

describe("update channel check", () => {
  const now = Date.parse("2026-11-22T10:00:00Z");
  const base = { version: "12.1.2", checksEnabled: true, latest: "12.1.2", lastCheck: now, now };

  test("current release", () => {
    expect(updateChannelCheck(base)).toEqual({
      name: "update_channel",
      status: "ok",
      detail: "channel=release version=12.1.2 latest=12.1.2 checks=on",
    });
  });

  test("a newer release names the update command", () => {
    const check = updateChannelCheck({ ...base, latest: "12.2.0" });
    expect(check.status).toBe("warn");
    expect(check.hint).toContain("subkit update");
  });

  test("checks that never succeeded for a week warn", () => {
    expect(updateChannelCheck({ ...base, lastCheck: now - 8 * 86_400_000 }).status).toBe("warn");
    expect(updateChannelCheck({ ...base, lastCheck: null }).status).toBe("warn");
    expect(updateChannelCheck({ ...base, lastCheck: null, checksEnabled: false }).status).toBe(
      "ok",
    );
  });

  test("dev builds are their own channel", () => {
    expect(updateChannelCheck({ ...base, version: "0.0.0-dev" }).detail).toContain("channel=dev");
  });
});

describe("reachability check", () => {
  const health = { status: "ok", version: "12.1.2" };
  const ready = {
    status: "ready" as const,
    service: "subkit" as const,
    checks: { lifecycle: "pass" as const, database: "pass" as const, schema: "pass" as const },
    failing: [],
  };

  test("ready engine", () => {
    expect(reachabilityCheck(health, ready)).toEqual({
      name: "reachability",
      status: "ok",
      detail: "engine live=ok ready=ready version=12.1.2 database=pass schema=pass failing=none",
    });
  });

  test("names the failing dependency and the next step", () => {
    const check = reachabilityCheck(health, {
      ...ready,
      status: "not_ready",
      checks: { ...ready.checks, database: "fail" },
      failing: ["database"],
    });
    expect(check.status).toBe("blocked");
    expect(check.detail).toContain("failing=database");
    expect(check.hint).toContain("DATABASE_URL");
  });

  test("draining engine", () => {
    const check = reachabilityCheck(health, {
      ...ready,
      status: "not_ready",
      checks: { ...ready.checks, lifecycle: "fail" },
      failing: ["lifecycle"],
    });
    expect(check.status).toBe("blocked");
    expect(check.hint).toContain("draining");
  });
});

test("worst status wins", () => {
  expect(
    worst([
      { name: "a", status: "ok", detail: "" },
      { name: "b", status: "warn", detail: "" },
    ]),
  ).toBe("warn");
  expect(worst([{ name: "a", status: "blocked", detail: "" }])).toBe("blocked");
});
