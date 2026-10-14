import { describe, expect, test } from "bun:test";
import { resolveCockpitDemoInstance } from "./cockpit-demo-instance.ts";
import {
  assertLifecycleInstanceIsolated,
  cockpitDemoSeedDefinitionFingerprint,
  dockerIdentityUnchanged,
  lifecycleCommands,
  lifecycleReceipt,
  runLifecycleSequence,
  validateLifecycleInstanceEvidence,
} from "./cockpit-demo-lifecycle-harness.ts";

const instance = resolveCockpitDemoInstance(
  {
    SUBKIT_DEMO_INSTANCE: "lifecycle-test",
    SUBKIT_TEST_PORT: "3401",
    SUBKIT_DEMO_DB_PORT: "55451",
  },
  "/repo",
);

describe("local demo lifecycle harness", () => {
  test("requires a new named namespace, dedicated ports, and an unused state path", () => {
    expect(() =>
      assertLifecycleInstanceIsolated(instance, false, new Set(), { containers: [], volumes: [] }),
    ).not.toThrow();
    expect(() =>
      assertLifecycleInstanceIsolated(instance, true, new Set(), { containers: [], volumes: [] }),
    ).toThrow("state path");
    expect(() =>
      assertLifecycleInstanceIsolated(instance, false, new Set([3401]), {
        containers: [],
        volumes: [],
      }),
    ).toThrow("port collision");
    expect(() =>
      assertLifecycleInstanceIsolated(instance, false, new Set(), {
        containers: ["owned"],
        volumes: [],
      }),
    ).toThrow("already owns resources");
  });

  test("compares exact default project container and volume identities independent of order", () => {
    expect(
      dockerIdentityUnchanged(
        { containers: ["c1", "c2"], volumes: ["v1"] },
        { containers: ["c2", "c1"], volumes: ["v1"] },
      ),
    ).toBe(true);
    expect(
      dockerIdentityUnchanged(
        { containers: ["c1"], volumes: ["v1"] },
        { containers: ["c1"], volumes: ["v2"] },
      ),
    ).toBe(false);
  });

  test("fingerprints the seed definition source without masking meaningful fixture changes", () => {
    expect(cockpitDemoSeedDefinitionFingerprint("seed('2026-10-14T10:00:00.000Z')")).not.toBe(
      cockpitDemoSeedDefinitionFingerprint("seed('2026-10-14T10:05:00.000Z')"),
    );
    expect(cockpitDemoSeedDefinitionFingerprint("seed definition")).toBe(
      cockpitDemoSeedDefinitionFingerprint("seed definition"),
    );
  });

  test("requires all running services, exact engine image, and database and object volumes before cleanup", () => {
    const evidence = {
      builtImageDigest: "sha256:engine-image",
      runningServices: [
        {
          id: "engine-id",
          name: "demo-engine",
          imageDigest: "sha256:engine-image",
          state: "Up 10 seconds",
          service: "engine",
        },
        {
          id: "postgres-id",
          name: "demo-postgres",
          imageDigest: "sha256:postgres",
          state: "Up 10 seconds",
          service: "postgres",
        },
        {
          id: "objects-id",
          name: "demo-objects",
          imageDigest: "sha256:objects",
          state: "Up 10 seconds",
          service: "object-store",
        },
      ],
      volumes: ["demo_demo-postgres", "demo_demo-objects"],
      databaseVolumeIdentity: "demo_demo-postgres",
      objectStoreVolumeIdentity: "demo_demo-objects",
      serviceGenerationSha256: "f".repeat(64),
      fixtureManifestSha256: "d".repeat(64),
      fixtureDataSha256: "e".repeat(64),
      seedDefinitionSha256: "a".repeat(64),
      fixtureIdsSha256: "b".repeat(64),
      fixtureIds: ["fixture-1"],
      keyStableAcrossReseed: true,
      countsStableAcrossReseed: true,
    };
    const identity = {
      containers: [
        "engine-id|demo-engine|subkit:demo",
        "postgres-id|demo-postgres|postgres:17",
        "objects-id|demo-objects|minio:latest",
      ],
      volumes: evidence.volumes,
    };
    expect(validateLifecycleInstanceEvidence(identity, evidence)).toBeNull();
    expect(validateLifecycleInstanceEvidence({ ...identity, volumes: [] }, evidence)).toBe(
      "volume_identity_mismatch",
    );
    expect(
      validateLifecycleInstanceEvidence(identity, {
        ...evidence,
        runningServices: evidence.runningServices.slice(0, 2),
      }),
    ).toBe("required_service_missing");
    expect(
      validateLifecycleInstanceEvidence(identity, {
        ...evidence,
        runningServices: evidence.runningServices.map((entry) =>
          entry.service === "engine" ? { ...entry, imageDigest: "sha256:old" } : entry,
        ),
      }),
    ).toBe("engine_image_mismatch");
  });

  test("runs the explicit lifecycle order with captured numeric exits and fail-fast behavior", () => {
    const calls: string[][] = [];
    const exits = runLifecycleSequence(
      lifecycleCommands,
      (args) => {
        calls.push(args);
        return { status: calls.length === 3 ? 17 : 0 };
      },
      {},
    );
    expect(calls).toEqual([[], ["--stop"], ["--restart"]]);
    expect(exits).toEqual([
      { operation: "start", status: 0 },
      { operation: "stop", status: 0 },
      { operation: "restart", status: 17 },
    ]);
  });

  test("receipt records only numeric command status and exact identity comparison", () => {
    const receipt = lifecycleReceipt({
      instance,
      hashes: { source_sha256: "a".repeat(64) },
      before: { containers: ["before"], volumes: ["volume"] },
      after: { containers: ["before"], volumes: ["volume"] },
      exits: [{ operation: "start", status: 0 }],
      runnerSha256: "b".repeat(64),
      sourceHead: "c".repeat(40),
      fixtureManifestSha256: "d".repeat(64),
      fixtureDataSha256: "e".repeat(64),
      instanceBeforeCleanup: null,
      projectIdentityBeforeCleanup: { containers: ["before"], volumes: ["volume"] },
      cleanupStatus: 0,
      cleanupAttempted: true,
      cleanupReason: "cleanup_succeeded",
      isolatedAfterCleanup: { containers: [], volumes: [] },
      cleanupRecovery: "project-scoped fallback",
      failureCode: null,
    });
    expect(receipt.default_demo_identity.unchanged).toBe(true);
    expect(receipt.commands).toEqual([{ operation: "start", status: 0 }]);
    expect(receipt.fixture_manifest_sha256).toBe("d".repeat(64));
    expect(receipt.project_identity_before_cleanup).toEqual({
      containers: ["before"],
      volumes: ["volume"],
    });
    expect(receipt.cleanup.status).toBe(0);
    expect(receipt.cleanup.isolatedProjectEmpty).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain("api_key");
  });
});
