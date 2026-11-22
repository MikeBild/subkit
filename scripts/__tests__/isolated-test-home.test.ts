import { afterEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  claimIsolatedTestHome,
  createIsolatedTestHome,
  removeIsolatedTestHome,
} from "../../apps/subkit/src/tests/isolated-test-home";

const candidate = path.resolve(import.meta.dir, "..", "..");
let root: string | undefined;
let fixture: string | undefined;

function makeFixture(): string {
  if (fixture) return fixture;
  root = mkdtempSync(path.join(tmpdir(), "h1-isolated-home-project-"));
  for (const source of [
    "apps/subkit/src/tests/isolated-test-home.ts",
    "apps/subkit/src/tests/setup-isolated-home.ts",
    "apps/subkit/src/tests/run-isolated-test-file.ts",
    "scripts/lib/owned-process-watchdog.ts",
    "scripts/test-files-isolated.ts",
  ]) {
    const destination = path.join(root, source);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(candidate, source), destination);
  }
  writeFileSync(
    path.join(root, "bunfig.toml"),
    '[test]\npreload = ["./apps/subkit/src/tests/setup-isolated-home.ts"]\n',
  );
  fixture = path.join(root, "scripts", "fixtures");
  mkdirSync(fixture, { recursive: true });
  return fixture;
}

function relative(file: string): string {
  return path.relative(root!, file);
}

function writeFixture(name: string, body: string): string {
  const file = path.join(makeFixture(), name);
  writeFileSync(file, body);
  return file;
}

async function runRunner(workers: number, targets: string[], parentHome?: string) {
  const child = Bun.spawn(["bun", "run", "scripts/test-files-isolated.ts", ...targets], {
    cwd: root!,
    env: {
      ...process.env,
      ...(parentHome ? { HOME: parentHome, USERPROFILE: parentHome } : {}),
      SUBKIT_TEST_WORKERS: String(workers),
      SUBKIT_TEST_WORKER_CHILD: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: await child.exited, stderr: await new Response(child.stderr).text() };
}

function recorded(...names: string[]): string[] {
  return names.flatMap((name) =>
    readFileSync(path.join(makeFixture(), name), "utf8").trim().split("\n").filter(Boolean),
  );
}

async function copiedSeam() {
  return await import(
    pathToFileURL(path.join(root!, "apps/subkit/src/tests/run-isolated-test-file.ts")).href
  );
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
  fixture = undefined;
});

describe("isolated test homes", () => {
  test("runs parallel runner shards with separate homes and reaps each successful child", async () => {
    const first = path.join(makeFixture(), "first-home.txt");
    const second = path.join(makeFixture(), "second-home.txt");
    writeFixture(
      "first.test.ts",
      `import { test } from "bun:test"; import { writeFileSync } from "node:fs"; test("first", () => writeFileSync(${JSON.stringify(first)}, process.env.HOME!));`,
    );
    writeFixture(
      "second.test.ts",
      `import { test } from "bun:test"; import { writeFileSync } from "node:fs"; test("second", () => writeFileSync(${JSON.stringify(second)}, process.env.HOME!));`,
    );

    const parentHome = mkdtempSync(path.join(tmpdir(), "h1-parent-home-"));
    writeFileSync(path.join(parentHome, "keep"), "parent data");
    try {
      const result = await runRunner(2, [relative(makeFixture())], parentHome);
      expect(result.code, result.stderr).toBe(0);
      expect(readFileSync(path.join(parentHome, "keep"), "utf8")).toBe("parent data");
    } finally {
      rmSync(parentHome, { recursive: true, force: true });
    }
    const homes = recorded("first-home.txt", "second-home.txt");
    expect(new Set(homes).size).toBe(2);
    expect(homes.every((home) => !existsSync(home))).toBe(true);
  });

  test("reaps the child home when the test fails", async () => {
    const report = path.join(makeFixture(), "failed-home.txt");
    writeFixture(
      "failure.test.ts",
      `import { expect, test } from "bun:test"; import { writeFileSync } from "node:fs"; test("failure", () => { writeFileSync(${JSON.stringify(report)}, process.env.HOME!); expect(true).toBe(false); });`,
    );

    const result = await runRunner(1, [relative(makeFixture())]);
    expect(result.code, result.stderr).toBe(1);
    const [home] = recorded("failed-home.txt");
    expect(home).toBeTruthy();
    expect(existsSync(home!)).toBe(false);
  });

  test("reports an actual spawn error and cleans only its private TMPDIR", async () => {
    const privateTmp = mkdtempSync(path.join(tmpdir(), "h1-spawn-private-"));
    const probe = writeFixture(
      "spawn-probe.ts",
      `import { runIsolatedTestFile } from "../../apps/subkit/src/tests/run-isolated-test-file"; try { await runIsolatedTestFile("missing.test.ts", { cwd: "${path.join(makeFixture(), "missing")}" }); } catch { const roots = [...new Bun.Glob("subkit-test-home-*").scanSync({ cwd: process.env.TMPDIR! })]; if (roots.length === 0) console.log("clean"); }`,
    );
    const child = Bun.spawn(["bun", probe], {
      cwd: root!,
      env: { ...process.env, TMPDIR: privateTmp },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(output.trim()).toBe("clean");
    rmSync(privateTmp, { recursive: true, force: true });
  });

  test("TERM-ignoring ready child is KILLed, reaped, and its root removed", async () => {
    const ready = path.join(makeFixture(), "ready.txt");
    const ignored = path.join(makeFixture(), "ignored.txt");
    const hanging = writeFixture(
      "hang.test.ts",
      `import { test } from "bun:test"; import { writeFileSync } from "node:fs"; process.on("SIGTERM", () => writeFileSync(${JSON.stringify(ignored)}, "ignored")); writeFileSync(${JSON.stringify(ready)}, process.env.HOME! + " " + process.pid); test("hang", async () => await new Promise(() => {}));`,
    );
    const { runIsolatedTestFile: runCopied } = await copiedSeam();
    await expect(
      runCopied(relative(hanging), { cwd: root!, deadlineMs: 1_000, killGraceMs: 180 }),
    ).rejects.toThrow("1000ms process deadline");
    expect(readFileSync(ignored, "utf8")).toBe("ignored");
    const [home, pid] = recorded("ready.txt")[0]!.split(" ");
    expect(existsSync(home!)).toBe(false);
    expect(() => process.kill(Number(pid), 0)).toThrow();
  }, 10_000);

  test("one direct bun test process keeps its valid home across two files then cleans it", async () => {
    const one = path.join(makeFixture(), "one.txt");
    const two = path.join(makeFixture(), "two.txt");
    const first = writeFixture(
      "one.test.ts",
      `import { test } from "bun:test"; import { writeFileSync } from "node:fs"; test("one", () => writeFileSync(${JSON.stringify(one)}, process.env.HOME!));`,
    );
    const second = writeFixture(
      "two.test.ts",
      `import { expect, test } from "bun:test"; import { existsSync, writeFileSync } from "node:fs"; test("two", () => { expect(existsSync(process.env.HOME!)).toBe(true); writeFileSync(${JSON.stringify(two)}, process.env.HOME!); });`,
    );
    const child = Bun.spawn(["bun", "test", `./${relative(first)}`, `./${relative(second)}`], {
      cwd: root!,
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    const homes = recorded("one.txt", "two.txt");
    expect(new Set(homes).size).toBe(1);
    expect(existsSync(homes[0]!)).toBe(false);
  });

  test("a direct failing file does not invalidate the shared home for its next file", async () => {
    const failed = path.join(makeFixture(), "direct-failed.txt");
    const continued = path.join(makeFixture(), "direct-continued.txt");
    const first = writeFixture(
      "direct-fail.test.ts",
      `import { expect, test } from "bun:test"; import { writeFileSync } from "node:fs"; test("fails", () => { writeFileSync(${JSON.stringify(failed)}, process.env.HOME!); expect(true).toBe(false); });`,
    );
    const second = writeFixture(
      "direct-continues.test.ts",
      `import { expect, test } from "bun:test"; import { existsSync, writeFileSync } from "node:fs"; test("continues", () => { expect(existsSync(process.env.HOME!)).toBe(true); writeFileSync(${JSON.stringify(continued)}, process.env.HOME!); });`,
    );
    const child = Bun.spawn(["bun", "test", `./${relative(first)}`, `./${relative(second)}`], {
      cwd: root!,
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(1);
    const homes = recorded("direct-failed.txt", "direct-continued.txt");
    expect(new Set(homes).size).toBe(1);
    expect(existsSync(homes[0]!)).toBe(false);
  });

  test("a nested bun test gets a separate home and both homes are cleaned", async () => {
    const outer = path.join(makeFixture(), "outer.txt");
    const inner = path.join(makeFixture(), "inner.txt");
    const innerFile = writeFixture(
      "nested-inner.test.ts",
      `import { test } from "bun:test"; import { writeFileSync } from "node:fs"; test("inner", () => writeFileSync(${JSON.stringify(inner)}, process.env.HOME!));`,
    );
    const outerFile = writeFixture(
      "nested-outer.test.ts",
      `import { expect, test } from "bun:test"; import { writeFileSync } from "node:fs"; test("outer", async () => { writeFileSync(${JSON.stringify(outer)}, process.env.HOME!); const child = Bun.spawn(["bun", "test", ${JSON.stringify(`./${relative(innerFile)}`)}], { cwd: ${JSON.stringify(root!)}, env: { ...process.env }, stdout: "pipe", stderr: "pipe" }); expect(await child.exited).toBe(0); });`,
    );
    const child = Bun.spawn(["bun", "test", `./${relative(outerFile)}`], {
      cwd: root!,
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    const homes = recorded("outer.txt", "inner.txt");
    expect(new Set(homes).size).toBe(2);
    expect(homes.every((home) => !existsSync(home))).toBe(true);
  });

  test("rejects foreign, stale, and symlink claims without removing a real parent home", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "h1-parent-home-"));
    const foreign = mkdtempSync(path.join(tmpdir(), "subkit-test-home-foreign-"));
    const owned = createIsolatedTestHome();
    const stale = owned.path;
    rmSync(stale, { recursive: true, force: true });
    const link = path.join(parent, "unsafe-test-home-link");
    symlinkSync(parent, link);
    try {
      expect(() => claimIsolatedTestHome(foreign, "not-ours")).toThrow();
      expect(() => claimIsolatedTestHome(stale, owned.token)).toThrow("no longer exists");
      expect(() => claimIsolatedTestHome(link, "not-ours")).toThrow();
      expect(() => removeIsolatedTestHome(owned)).not.toThrow();
      expect(lstatSync(parent).isDirectory()).toBe(true);
    } finally {
      rmSync(link, { force: true });
      rmSync(foreign, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("captures TMPDIR at load time despite a later environment change", async () => {
    const originalTmp = mkdtempSync(path.join(tmpdir(), "h1-captured-tmp-"));
    const laterTmp = mkdtempSync(path.join(tmpdir(), "h1-later-tmp-"));
    try {
      const report = path.join(makeFixture(), "tmpdir.txt");
      const probe = writeFixture(
        "tmpdir-probe.ts",
        `import { createIsolatedTestHome, removeIsolatedTestHome } from "../../apps/subkit/src/tests/isolated-test-home"; process.env.TMPDIR = ${JSON.stringify(laterTmp)}; const home = createIsolatedTestHome(); console.log(home.path); removeIsolatedTestHome(home);`,
      );
      const child = Bun.spawn(["bun", probe], {
        cwd: root!,
        env: { ...process.env, TMPDIR: originalTmp },
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      writeFileSync(report, output.trim());
      expect(path.dirname(readFileSync(report, "utf8"))).toBe(realpathSync(originalTmp));
      expect([...new Bun.Glob("subkit-test-home-*").scanSync({ cwd: originalTmp })]).toEqual([]);
    } finally {
      rmSync(originalTmp, { recursive: true, force: true });
      rmSync(laterTmp, { recursive: true, force: true });
    }
  });
});
