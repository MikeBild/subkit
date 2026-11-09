import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIsolatedTestFile } from "./run-isolated-test-file.ts";

const dockerPluginAvailable =
  Bun.which("docker") !== null &&
  [
    "/Applications/Docker.app/Contents/Resources/cli-plugins",
    "/usr/local/lib/docker/cli-plugins",
    "/usr/local/libexec/docker/cli-plugins",
    "/usr/lib/docker/cli-plugins",
    "/usr/libexec/docker/cli-plugins",
  ].some(existsSync);

test.skipIf(!dockerPluginAvailable)(
  "Docker Compose plugin resolves from an isolated home without reading user Docker config",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "subkit-isolated-docker-plugin-"));
    const testPath = join(root, "plugin-resolution.docker.test.ts");
    writeFileSync(
      testPath,
      `import { expect, test } from "bun:test";\n` +
        `import { readFileSync } from "node:fs";\n` +
        `import { join } from "node:path";\n` +
        `test("compose plugin resolves", async () => {\n` +
        `  expect(process.env.DOCKER_CONFIG).toBe(join(process.env.HOME!, ".docker"));\n` +
        `  expect(process.env.DOCKER_HOST).toBeTruthy();\n` +
        `  const config = JSON.parse(readFileSync(join(process.env.DOCKER_CONFIG!, "config.json"), "utf8"));\n` +
        `  expect(Object.keys(config)).toEqual(["cliPluginsExtraDirs"]);\n` +
        `  const child = Bun.spawn(["docker", "compose", "version"], { stdout: "pipe", stderr: "pipe" });\n` +
        `  expect(await child.exited).toBe(0);\n` +
        `  const daemon = Bun.spawn(["docker", "info", "--format", "{{.ServerVersion}}"], { stdout: "pipe", stderr: "pipe" });\n` +
        `  expect(await daemon.exited).toBe(0);\n` +
        `  const buildx = Bun.spawn(["docker", "buildx", "version"], { stdout: "pipe", stderr: "pipe" });\n` +
        `  expect(await buildx.exited).toBe(0);\n` +
        `});\n`,
    );
    try {
      await expect(runIsolatedTestFile(testPath, { cwd: root, deadlineMs: 15_000 })).resolves.toBe(
        undefined,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  20_000,
);

test("keeps an explicit Docker config for an isolated Docker test", async () => {
  const root = mkdtempSync(join(tmpdir(), "subkit-isolated-docker-config-"));
  const testPath = join(root, "explicit-config.docker.test.ts");
  const dockerConfig = join(root, "caller-docker-config");
  writeFileSync(
    testPath,
    `import { expect, test } from "bun:test";\n` +
      `test("explicit config", () => expect(process.env.DOCKER_CONFIG).toBe(${JSON.stringify(dockerConfig)}));\n`,
  );
  try {
    await expect(
      runIsolatedTestFile(testPath, { cwd: root, env: { DOCKER_CONFIG: dockerConfig } }),
    ).resolves.toBe(undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "timeout reaps a descendant process before removing its isolated home",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "subkit-isolated-runner-"));
    const pidPath = join(root, "descendant.pid");
    const testPath = join(root, "stubborn.test.ts");
    writeFileSync(
      testPath,
      `import { test } from "bun:test";\n` +
        `test("stubborn", async () => {\n` +
        `  Bun.spawn(["/bin/sh", "-c", "trap '' TERM; echo $$ > \\"$PID_PATH\\"; while :; do sleep 1; done"]);\n` +
        `  await new Promise<void>(() => {});\n` +
        `});\n`,
    );
    try {
      await expect(
        runIsolatedTestFile(testPath, {
          cwd: root,
          deadlineMs: 3_000,
          killGraceMs: 50,
          env: { PID_PATH: pidPath },
        }),
      ).rejects.toThrow("exceeded the 3000ms process deadline");
      expect(existsSync(pidPath)).toBe(true);
      const pid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
      expect(Number.isInteger(pid)).toBe(true);
      await Bun.sleep(100);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("Docker builds preserve an explicit caller deadline and clean their owned home", async () => {
  const root = mkdtempSync(join(tmpdir(), "subkit-docker-deadline-"));
  const marker = join(root, "home.txt");
  const file = join(root, "deadline.docker.test.ts");
  writeFileSync(
    file,
    `import { test } from "bun:test";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, process.env.HOME!);
test("wait", async () => { await new Promise(() => {}); });
`,
  );
  try {
    await expect(
      runIsolatedTestFile(file, {
        cwd: root,
        deadlineMs: 3000,
        killGraceMs: 50,
        env: { DOCKER_HOST: "unix:///unused-test-endpoint" },
      }),
    ).rejects.toThrow("exceeded the 3000ms process deadline");
    expect(existsSync(marker)).toBe(true);
    expect(existsSync(readFileSync(marker, "utf8"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);
