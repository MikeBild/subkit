import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createDockerTestRun,
  createIsolatedDockerTestRun,
  dockerTestChildEnv,
  hasValidCpuProfile,
  parseDockerContextEvidence,
  runEnv,
  withPublishedPorts,
} from "./_run.ts";

describe("isolated Docker test run", () => {
  test("port discovery preserves Compose bindings across replacement and test processes", () => {
    const run = createDockerTestRun("unit", {});
    const resolved = withPublishedPorts(run, "45123", "45124");
    expect(resolved.baseUrl).toBe("http://127.0.0.1:45123");
    expect(resolved.publishedDbPort).toBe("45124");
    expect(runEnv(resolved).SUBKIT_TEST_PORT).toBe("0");
    expect(runEnv(resolved).SUBKIT_DB_PORT).toBe("0");
    const replaced = withPublishedPorts(resolved, "45125", "45124");
    expect(replaced.baseUrl).toBe("http://127.0.0.1:45125");
    expect(runEnv(replaced).SUBKIT_TEST_PORT).toBe("0");
    expect(run.baseUrl).toBe("http://127.0.0.1:0");
  });
  test("preserves a supplied pinned image and derives the matching base URL", () => {
    const run = createDockerTestRun("unit", {
      SUBKIT_DOCKER_PROJECT: "subkit-test-unit",
      SUBKIT_TEST_IMAGE: "subkit:unit-pinned",
      SUBKIT_TEST_PORT: "45123",
      SUBKIT_DB_PORT: "45124",
    });
    expect(run).toMatchObject({
      project: "subkit-test-unit",
      image: "subkit:unit-pinned",
      apiPort: "45123",
      dbPort: "45124",
      baseUrl: "http://127.0.0.1:45123",
    });
    expect(runEnv(run)).toMatchObject({
      COMPOSE_PROJECT_NAME: "subkit-test-unit",
      SUBKIT_TEST_IMAGE: "subkit:unit-pinned",
    });
  });

  test("isolated runs ignore inherited Docker project, ports, and image", () => {
    const isolated = createIsolatedDockerTestRun("unit", {
      SUBKIT_DOCKER_PROJECT: "foreign-project",
      SUBKIT_TEST_IMAGE: "foreign-image",
      SUBKIT_TEST_PORT: "45123",
      SUBKIT_DB_PORT: "45124",
      SUBKIT_DOCKER_RUN_ID: "foreign-run",
    });
    expect(isolated.project).not.toBe("foreign-project");
    expect(isolated.image).not.toBe("foreign-image");
    expect(isolated.apiPort).toBe("0");
    expect(isolated.dbPort).toBe("0");
    expect(isolated.runId).not.toBe("foreign-run");
  });

  test("owned cold runs clear inherited bootstrap and keep-alive state", () => {
    const run = createIsolatedDockerTestRun("unit");
    const cold = dockerTestChildEnv(run, "cold", "changed", {
      SUBKIT_DOCKER_API_KEY: "foreign-key",
      SUBKIT_DOCKER_KEEP_ALIVE: "1",
    });
    expect(cold.SUBKIT_DOCKER_API_KEY).toBeUndefined();
    expect(cold.SUBKIT_DOCKER_KEEP_ALIVE).toBe("0");
    expect(cold.SUBKIT_DOCKER_SEED_STATE).toBe("changed");
    expect(cold.SUBKIT_DOCKER_MANAGED).toBe("1");
  });
});

test("profile evidence rejects empty, malformed and unsampled artifacts", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "subkit-profile-evidence-"));
  try {
    expect(hasValidCpuProfile(directory)).toBe(false);
    const file = path.join(directory, "engine.cpuprofile");
    writeFileSync(file, "{");
    expect(hasValidCpuProfile(directory)).toBe(false);
    writeFileSync(
      file,
      JSON.stringify({ nodes: [], samples: [], timeDeltas: [], startTime: 1, endTime: 2 }),
    );
    expect(hasValidCpuProfile(directory)).toBe(false);
    writeFileSync(
      file,
      JSON.stringify({
        nodes: [{ id: 1 }],
        samples: [1],
        timeDeltas: [1],
        startTime: 1,
        endTime: 2,
      }),
    );
    expect(hasValidCpuProfile(directory)).toBe(true);
    writeFileSync(
      file,
      JSON.stringify({
        nodes: [{ id: 1 }],
        samples: [1],
        timeDeltas: [],
        startTime: 1,
        endTime: 2,
      }),
    );
    expect(hasValidCpuProfile(directory)).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Docker build-context evidence requires an image-stamped digest and manifest", () => {
  const manifest =
    "drwxr-xr-x 0/0 0 1970-01-01 00:00 ./\n-rw-r--r-- 0/0 4 1970-01-01 00:00 ./file\n";
  const digest = "a".repeat(64);
  expect(parseDockerContextEvidence(`${digest}\n`, manifest)).toEqual({
    digest,
    manifest_sha256: "e08b17dcc4e236ed784e71abf9103425ff6ae543a74bd06043d19fc6efa937d8",
    entries: 2,
  });
  expect(() => parseDockerContextEvidence("not-a-digest\n", manifest)).toThrow(
    "image build-context digest must be a SHA-256 hex value",
  );
  expect(() => parseDockerContextEvidence(`${digest}\n`, "")).toThrow(
    "image build-context manifest is empty",
  );
});
