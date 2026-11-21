import { describe, expect, test } from "bun:test";
import {
  COMPOSER_TRAY_TTL_MS,
  claimSelection,
  composerExpiry,
  liveEntries,
  trayAdmission,
} from "./composer-tray-model.ts";

const NOW = new Date("2026-11-21T10:00:00.000Z");

function entry(id: string, file_id = `f-${id}`, expiresInMs = 60_000) {
  return { id, file_id, expires_at: new Date(NOW.getTime() + expiresInMs) };
}

describe("composer tray", () => {
  test("a staged file waits one day", () => {
    expect(composerExpiry(NOW).getTime() - NOW.getTime()).toBe(COMPOSER_TRAY_TTL_MS);
  });

  test("expired entries are not live", () => {
    expect(liveEntries([entry("a"), entry("b", "f-b", -1), entry("c", "f-c", 0)], NOW)).toEqual([
      entry("a"),
    ]);
  });

  test("a new file is added until the tray is full", () => {
    expect(trayAdmission([entry("a")], "f-new", 2)).toBe("add");
    expect(trayAdmission([entry("a"), entry("b")], "f-new", 2)).toBe("full");
  });

  test("staging the same file again refreshes it, even in a full tray", () => {
    expect(trayAdmission([entry("a"), entry("b")], "f-a", 2)).toBe("refresh");
  });

  test("claiming without ids takes every live entry", () => {
    expect(claimSelection([entry("a"), entry("b")], undefined)).toEqual({
      ok: true,
      claim: [entry("a"), entry("b")],
    });
  });

  test("claiming named ids takes exactly those, once each", () => {
    expect(claimSelection([entry("a"), entry("b")], ["b", "b"])).toEqual({
      ok: true,
      claim: [entry("b")],
    });
  });

  test("an id that is not in the tray refuses the whole claim", () => {
    expect(claimSelection([entry("a")], ["a", "x"])).toEqual({ ok: false, missing: ["x"] });
  });
});
