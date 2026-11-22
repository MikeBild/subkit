import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  engineBuildCommand,
  engineDesktopPath,
  engineMetafile,
  nativeDependenciesCommand,
} from "../build-engine-desktop.ts";
import { plan } from "../lib/commands.ts";
import { ENGINE_DESKTOP_TARGETS } from "../lib/engine-desktop-targets.ts";

const ROOT = join(import.meta.dir, "..", "..");
const CTX = { version: "1.2.3", platform: "linux" };

describe("desktop engine targets", () => {
  test("cover macOS on Apple silicon and Windows x64, and no Intel Mac", () => {
    expect(ENGINE_DESKTOP_TARGETS.map((t) => t.bunTarget)).toEqual([
      "bun-darwin-arm64",
      "bun-windows-x64",
    ]);
  });

  test("land where the desktop bundle config picks them up per architecture", () => {
    const config = readFileSync(join(ROOT, "apps/desktop/electron-builder.base.yml"), "utf8");
    for (const target of ENGINE_DESKTOP_TARGETS) {
      expect(engineDesktopPath("out", target)).toBe(
        join("out", target.os, target.arch, target.file),
      );
    }
    const mac = ENGINE_DESKTOP_TARGETS.filter((target) => target.os === "mac");
    expect(mac).toHaveLength(1);
    for (const target of mac)
      expect(config).toMatch(
        new RegExp(`dist/engine-desktop/${target.os}/\\$\\{arch\\}/${target.file}`),
      );
  });
});

describe("desktop engine build", () => {
  test("installs the native packages of each target before compiling it", () => {
    expect(ENGINE_DESKTOP_TARGETS.map((t) => nativeDependenciesCommand(t).join(" "))).toEqual([
      "bun install --frozen-lockfile --os=darwin --cpu=arm64",
      "bun install --frozen-lockfile --os=win32 --cpu=x64",
    ]);
    expect(ENGINE_DESKTOP_TARGETS.map((t) => engineMetafile("out", t))).toEqual([
      join("out", "meta", "mac-arm64.json"),
      join("out", "meta", "win-x64.json"),
    ]);
  });

  test("compiles the same entries and flags as the Linux image build", () => {
    const [target] = ENGINE_DESKTOP_TARGETS;
    const command = engineBuildCommand(target, "1.2.3", "out/engine", "out/engine.json").join(" ");
    const linux = plan("build", ["engine", "--skip-deps", "--outfile", "out/engine"], CTX);
    if (!linux.ok) throw new Error(linux.usage);
    const image = linux.steps.map((step) => step.argv.join(" ")).join("\n");
    expect(image).toContain(
      "apps/engine/src/index.ts apps/engine/src/embeddings/embedding-worker.ts --compile --root . --external cpu-features --define process.env.NODE_ENV=process.env.NODE_ENV",
    );
    expect(readFileSync(join(ROOT, "Dockerfile"), "utf8")).toContain("bun run build engine");
    expect(command).toBe(
      'bun build apps/engine/src/index.ts apps/engine/src/embeddings/embedding-worker.ts --compile --root . --external cpu-features --target=bun-darwin-arm64 --define process.env.NODE_ENV=process.env.NODE_ENV --define BUILD_VERSION="1.2.3" --metafile=out/engine.json --outfile out/engine',
    );
  });

  test("prepares the embedded cockpit, clipper and embedding assets first", () => {
    const desktop = plan("build", ["desktop-engine"], CTX);
    if (!desktop.ok) throw new Error(desktop.usage);
    expect(desktop.steps.map((step) => step.label)).toEqual([
      "build clipper",
      "gen icons",
      "build cockpit",
      "embed cockpit",
      "fetch embedding assets",
      "compile desktop engines",
      "desktop engine notices",
    ]);
  });

  test("hands one target to the compile and the notices, and refuses an unknown one", () => {
    const argvOf = (args: string[]) => {
      const result = plan("build", ["desktop-engine", "--skip-deps", ...args], CTX);
      if (!result.ok) throw new Error(result.usage);
      return result.steps.map((step) => step.argv.join(" "));
    };
    expect(argvOf(["--target", "darwin-arm64"])).toEqual([
      "bun scripts/build-engine-desktop.ts --target darwin-arm64",
      "bun scripts/engine-desktop-notices.ts --target darwin-arm64",
    ]);
    expect(argvOf([])).toEqual([
      "bun scripts/build-engine-desktop.ts",
      "bun scripts/engine-desktop-notices.ts",
    ]);
    const unknown = plan("build", ["desktop-engine", "--target", "mac-arm64"], CTX);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.usage).toContain("--target darwin-arm64|windows-x64");
  });
});
