import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  cockpitDemoFingerprintInputs,
  cockpitDemoSourceFingerprint,
} from "./lib/cockpit-demo-fingerprint.ts";

describe("local demo source fingerprint", () => {
  test("tracks active Compose files and demo helpers while retaining discovered sources", () => {
    const root = mkdtempSync(join(tmpdir(), "subkit-demo-fingerprint-"));
    try {
      const paths = [...cockpitDemoFingerprintInputs, "apps/engine/src/index.ts"];
      for (const path of paths) {
        const absolute = join(root, path);
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, `initial ${path}`);
      }
      const initial = cockpitDemoSourceFingerprint(root, ["apps/engine/src/index.ts"]);
      for (const path of cockpitDemoFingerprintInputs) {
        writeFileSync(join(root, path), `changed ${path}`);
        expect(cockpitDemoSourceFingerprint(root, ["apps/engine/src/index.ts"])).not.toBe(initial);
        writeFileSync(join(root, path), `initial ${path}`);
      }
      writeFileSync(join(root, "apps/engine/src/index.ts"), "changed engine source");
      expect(cockpitDemoSourceFingerprint(root, ["apps/engine/src/index.ts"])).not.toBe(initial);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
