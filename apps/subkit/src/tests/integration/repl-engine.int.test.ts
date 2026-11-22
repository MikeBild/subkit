import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBootstrap } from "../../lib/bootstrap.ts";
import { hasCommand } from "../../repl/slash/hasCommand.ts";
import { ANONYMOUS_PROFILE, createFakeEngineClient } from "../_helpers/fake-engine-client.ts";

describe("integration: REPL persona resolution drives slash gating", () => {
  test("admin allow-set unlocks /audit and /clear", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "subkit-repl-int-"));
    try {
      const client = createFakeEngineClient();
      const snap = await loadBootstrap(client, ANONYMOUS_PROFILE, { cacheDir });
      expect(hasCommand("audit", snap.probe)).toBe(true);
      expect(hasCommand("clear", snap.probe)).toBe(true);
      expect(hasCommand("connector", snap.probe)).toBe(true);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test("enduser allow-set hides /audit but allows /clear", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "subkit-repl-int-"));
    try {
      const client = createFakeEngineClient({
        bootstrap: {
          permissions: ["conversation:read", "conversation:write", "memory:write"],
          permissions_checked: ["conversation:read"],
        },
      });
      const snap = await loadBootstrap(client, ANONYMOUS_PROFILE, { cacheDir });
      expect(hasCommand("audit", snap.probe)).toBe(false);
      expect(hasCommand("clear", snap.probe)).toBe(true);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test("network failure leaves the REPL with a conservative empty allow-set", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "subkit-repl-int-"));
    try {
      const client = createFakeEngineClient({
        errorOnBootstrap: new Error("ECONNREFUSED"),
        rbacAllow: () => false,
      });
      const snap = await loadBootstrap(client, ANONYMOUS_PROFILE, { cacheDir });
      expect(snap.source).toBe("fallback");
      expect(snap.allowed.size).toBe(0);
      expect(hasCommand("audit", snap.probe)).toBe(false);
      expect(hasCommand("help", snap.probe)).toBe(true);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
