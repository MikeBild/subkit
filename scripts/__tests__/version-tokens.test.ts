import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIN_SERVER_VERSION } from "../../apps/desktop/src/shared/server-contract.ts";
import { DESKTOP_MIN_VERSION_DEFAULT } from "../../apps/engine/src/config/schema.ts";
import {
  renderVersionTokens,
  repositoryVersionTokens,
  versionTokens,
} from "../lib/version-tokens.ts";

describe("renderVersionTokens", () => {
  test("replaces every known token", () => {
    expect(
      renderVersionTokens("v@@A@@ and `@@A@@-beta.1` need @@B@@", { A: "12.1.0", B: "12.0.0" }),
    ).toBe("v12.1.0 and `12.1.0-beta.1` need 12.0.0");
  });

  test("leaves text without tokens unchanged", () => {
    expect(renderVersionTokens("{{steps.fetch.body}} @ 1@2 @@lower@@", {})).toBe(
      "{{steps.fetch.body}} @ 1@2 @@lower@@",
    );
  });

  test("rejects an unknown token", () => {
    expect(() => renderVersionTokens("@@MISSING@@", { A: "1" })).toThrow(
      "unknown version token @@MISSING@@",
    );
  });
});

describe("versionTokens", () => {
  test("combines the package version, the Bun version and the code constants", () => {
    expect(versionTokens({ packageVersion: "12.1.0", bunVersion: "1.4.5" })).toEqual({
      SUBKIT_VERSION: "12.1.0",
      BUN_VERSION: "1.4.5",
      DESKTOP_MIN_SERVER_VERSION: MIN_SERVER_VERSION,
      DESKTOP_MIN_APP_VERSION: DESKTOP_MIN_VERSION_DEFAULT,
    });
  });

  test("reads package.json and .bun-version of the repository", () => {
    const root = join(import.meta.dir, "..", "..");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      version: string;
    };
    const tokens = repositoryVersionTokens();
    expect(tokens.SUBKIT_VERSION).toBe(pkg.version);
    expect(tokens.BUN_VERSION).toBe(readFileSync(join(root, ".bun-version"), "utf8").trim());
  });
});
