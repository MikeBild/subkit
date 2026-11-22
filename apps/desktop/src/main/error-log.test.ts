import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDiagnostics, redactKnown } from "../shared/diagnostics.ts";
import { ErrorLog } from "./error-log.ts";

const folder = mkdtempSync(join(tmpdir(), "subkit-errors-"));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const SECRETS = {
  databasePassword: "Zx9ruJ7-pQ2vW4mN8sT1aB6c",
  masterKey: "9f2c4e6a8b0d1f3e5a7c9b2d4f6e8a0c1b3d5f7e9a2c4b6d8f0e1a3c5b7d9f2e",
  launchSecret: "kT3mQ8vX1zR5nB7wY2cF6hJ9pL4sD0gA_e-uVoIiZ",
  providerKey: "AIzaSyD-local-workspace-provider-key-77",
};

describe("diagnostics carry no local workspace secrets", () => {
  test("errors recorded before and after a secret is known are both scrubbed", () => {
    const path = join(folder, "errors.json");
    const log = new ErrorLog(path);
    log.record(
      "local.start",
      new Error(`postgres://subkit:${SECRETS.databasePassword}@/postgres refused`),
    );
    log.addSecret(SECRETS.databasePassword);
    for (const secret of [SECRETS.masterKey, SECRETS.launchSecret, SECRETS.providerKey])
      log.addSecret(secret);
    log.record("local.engine", `MASTER_KEY=${SECRETS.masterKey} secret ${SECRETS.launchSecret}`);
    log.record("local.ai", new Error(`provider refused ${SECRETS.providerKey}`));
    const bundle = JSON.stringify(
      buildDiagnostics({
        appVersion: "11.3.0",
        electronVersion: "45",
        chromeVersion: "140",
        platform: "darwin",
        osRelease: "25",
        arch: "arm64",
        locale: "de",
        packaged: true,
        serverOrigin: "http://127.0.0.1:47811",
        serverVersion: "11.3.0",
        connection: "online",
        profileCount: 1,
        errors: log.entries,
        generatedAt: "2026-11-21T10:00:00.000Z",
      }),
    );
    const stored = readFileSync(path, "utf8");
    for (const secret of Object.values(SECRETS)) {
      expect(bundle).not.toContain(secret);
      expect(stored).not.toContain(secret);
    }
    expect(bundle).toContain("local.ai");
  });

  test("known secrets are replaced longest first and short values are left alone", () => {
    expect(redactKnown("a abcdefgh abcdefghij", ["abcdefgh", "abcdefghij"])).toBe(
      "a ***redacted*** ***redacted***",
    );
    expect(redactKnown("short abc", ["abc"])).toBe("short abc");
  });
});
