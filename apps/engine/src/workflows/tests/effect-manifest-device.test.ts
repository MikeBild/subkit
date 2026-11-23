import { describe, expect, test } from "bun:test";
import { workflowJsonDigest } from "../canonical-json.ts";
import { projectBoundaryGrowth } from "../core/authority-inheritance.ts";
import {
  compileWorkflowEffectManifest,
  deviceBindingFor,
  deviceBindingMismatch,
  deviceTarget,
  manifestDeviceIds,
} from "../core/effect-manifest.ts";
import { requestDigest } from "../core/request-protocol.ts";
import { WorkflowDefSchema } from "../types.ts";

const TENANT = "00000000-0000-4000-8000-000000000001";
const WORKFLOW = "00000000-0000-4000-8000-000000000002";
const VERSION = "00000000-0000-4000-8000-000000000003";
const CONNECTOR = "00000000-0000-4000-8000-000000000004";
const DEVICE = "66666666-6666-4666-8666-666666666666";
const OTHER_DEVICE = "77777777-7777-4777-8777-777777777777";

const step = {
  id: "write",
  kind: "request",
  connector_id: CONNECTOR,
  method: "POST",
  path: "/files.write",
  body: { folder_id: "berichte", relative_path: "woche.md", text: "ok" },
};

function compile(binding: Record<string, unknown>, steps: unknown[] = [step]) {
  return compileWorkflowEffectManifest({
    tenant_id: TENANT,
    workflow_id: WORKFLOW,
    workflow_version_id: VERSION,
    execution_environment: "prod",
    execution_options_digest: "a".repeat(64),
    definition: { name: "local", steps },
    bindings: [
      {
        tenant_id: TENANT,
        step_id: "write",
        connector_id: CONNECTOR,
        driver: "local_files",
        environment: "prod",
        request_digest: requestDigest(WorkflowDefSchema.parse({ name: "local", steps }).steps[0]),
        target: `device:${DEVICE}/files`,
        configuration_digest: "d".repeat(64),
        credential_binding_digest: null,
        rewrites_target: false,
        device: { device_id: DEVICE, capability: "files" },
        ...binding,
      },
    ],
  });
}

describe("a request step on a device connector", () => {
  test("binds the device into the manifest and stays approvable", () => {
    const result = compile({});
    expect(result.manifest.issues).toEqual([]);
    expect(result.eligible_for_repeated_runs).toBe(true);
    expect(result.manifest.effects[0]?.device).toEqual({ device_id: DEVICE, capability: "files" });
    expect(result.manifest.effects[0]?.effect).toBe("write");
    expect(manifestDeviceIds(result.manifest)).toEqual([DEVICE]);
  });

  test("the device is part of the digest", () => {
    expect(compile({}).digest).not.toBe(
      compile({ device: { device_id: OTHER_DEVICE, capability: "files" } }).digest,
    );
  });

  test("a local driver without a device, or with the wrong capability, is a mismatch", () => {
    expect(compile({ device: undefined }).manifest.issues).toEqual([
      { step_id: "write", code: "binding_mismatch" },
    ]);
    expect(
      compile({ device: { device_id: DEVICE, capability: "browser" } }).manifest.issues,
    ).toEqual([{ step_id: "write", code: "binding_mismatch" }]);
  });

  test("a device on a network driver is a mismatch", () => {
    expect(
      deviceBindingMismatch({ driver: "http", device: { device_id: DEVICE, capability: "files" } }),
    ).toBe(true);
    expect(deviceBindingMismatch({ driver: "http" })).toBe(false);
    for (const [driver, capability] of [
      ["local_files", "files"],
      ["local_browser", "browser"],
      ["local_computer", "computer"],
    ] as const) {
      expect(deviceBindingMismatch({ driver, device: { device_id: DEVICE, capability } })).toBe(
        false,
      );
      expect(deviceBindingMismatch({ driver })).toBe(true);
    }
  });

  test("a local driver on a graphql step is a mismatch", () => {
    const graphqlStep = { ...step, protocol: "graphql", graphql: { query: "mutation { write }" } };
    expect(compile({}, [graphqlStep]).manifest.issues).toContainEqual({
      step_id: "write",
      code: "binding_mismatch",
    });
  });

  test("a manifest without device steps names no device", () => {
    expect(manifestDeviceIds({ effects: [] })).toEqual([]);
  });
});

describe("growth when a new version runs on a device", () => {
  const onDevice = compile({}).manifest;
  const onOtherDevice = compile({
    device: { device_id: OTHER_DEVICE, capability: "files" },
    target: `device:${OTHER_DEVICE}/files`,
  }).manifest;
  const withoutDevice = { ...onDevice, effects: [] };

  test("the same device carries the approval forward", () => {
    expect(projectBoundaryGrowth(onDevice, onDevice).growth).toEqual([]);
  });

  test("a device the approval does not name is new_device growth", () => {
    expect(projectBoundaryGrowth(onDevice, onOtherDevice).growth).toEqual([
      {
        kind: "new_device",
        connector_id: CONNECTOR,
        target: `device:${OTHER_DEVICE}/files`,
        effect: "write",
        device_id: OTHER_DEVICE,
      },
    ]);
    expect(projectBoundaryGrowth(withoutDevice, onDevice).growth.map((g) => g.kind)).toEqual([
      "new_device",
    ]);
  });

  test("an approval with only network steps does not cover a device step", () => {
    const [effect] = onDevice.effects;
    if (!effect) throw new Error("device effect missing");
    const { device: _device, ...network } = effect;
    const networkOnly = { ...onDevice, effects: [{ ...network, driver: "http" as const }] };
    expect(projectBoundaryGrowth(networkOnly, onDevice).growth.map((g) => g.kind)).toEqual([
      "new_device",
    ]);
  });

  test("a new folder on the approved device grows the boundary, fewer folders do not", () => {
    const folder = (folder_id: string, access: "read" | "write") => ({
      folder_id,
      access,
      root_digest: "f".repeat(64),
    });
    const withFolders = (folders: ReturnType<typeof folder>[]) =>
      compile({ device: { device_id: DEVICE, capability: "files", folders } }).manifest;
    const approved = withFolders([folder("a", "read"), folder("b", "write")]);
    expect(projectBoundaryGrowth(approved, withFolders([folder("b", "write")])).growth).toEqual([]);
    expect(projectBoundaryGrowth(approved, onDevice).growth).toEqual([]);
    expect(
      projectBoundaryGrowth(approved, withFolders([folder("a", "write"), folder("c", "read")]))
        .growth,
    ).toEqual([
      {
        kind: "wider_folder_access",
        connector_id: CONNECTOR,
        target: `device:${DEVICE}/files`,
        effect: "write",
        device_id: DEVICE,
        item: "a",
      },
      {
        kind: "new_folder",
        connector_id: CONNECTOR,
        target: `device:${DEVICE}/files`,
        effect: "write",
        device_id: DEVICE,
        item: "c",
      },
    ]);
  });

  test("a device binding may name folders, websites and apps", () => {
    const result = compile({
      device: {
        device_id: DEVICE,
        capability: "files",
        sites: [{ origin: "https://shop.example", private: false, site_digest: "e".repeat(64) }],
        apps: [{ app_id: "com.apple.Numbers", app_digest: "e".repeat(64) }],
      },
    });
    expect(result.manifest.issues).toEqual([]);
    expect(result.manifest.effects[0]?.device?.sites).toHaveLength(1);
    expect(result.manifest.effects[0]?.device?.apps).toHaveLength(1);
  });

  test("an approval with a network step and a device step grows only by what is new", () => {
    const folder = { folder_id: "a", access: "read" as const, root_digest: "f".repeat(64) };
    const approved = compile({
      device: { device_id: DEVICE, capability: "files", folders: [folder] },
    }).manifest;
    const [effect] = approved.effects;
    if (!effect) throw new Error("device effect missing");
    const { device: _device, ...network } = effect;
    const mixed = {
      ...approved,
      effects: [{ ...network, step_id: "fetch", driver: "http" as const }, effect],
    };
    expect(projectBoundaryGrowth(mixed, approved).growth).toEqual([]);
  });

  test("unsorted or repeated device lists are a mismatch, so a digest has one form", () => {
    const folder = (folder_id: string) => ({
      folder_id,
      access: "read" as const,
      root_digest: "f".repeat(64),
    });
    expect(
      compile({
        device: { device_id: DEVICE, capability: "files", folders: [folder("b"), folder("a")] },
      }).manifest.issues,
    ).toEqual([{ step_id: "write", code: "binding_mismatch" }]);
  });

  test("dropping the device step is no growth", () => {
    expect(projectBoundaryGrowth(onDevice, withoutDevice).growth).toEqual([]);
  });
});

describe("the device a connector names", () => {
  test("a device connector names its device and capability", () => {
    expect(deviceBindingFor("local_browser", { device_id: DEVICE })).toEqual({
      device_id: DEVICE,
      capability: "browser",
    });
    expect(deviceTarget({ device_id: DEVICE, capability: "computer" })).toBe(
      `device:${DEVICE}/computer`,
    );
  });

  test("a network connector or a malformed device names none", () => {
    expect(deviceBindingFor("http", { device_id: DEVICE })).toBeNull();
    expect(deviceBindingFor("local_files", { device_id: "mac" })).toBeNull();
    expect(deviceBindingFor("local_files", null)).toBeNull();
    expect(deviceBindingFor("local_files", undefined)).toBeNull();
  });

  test("the devices of a manifest are listed once each, sorted, skipping network steps", () => {
    const at = (device_id: string | null) => ({
      ...(device_id ? { device: { device_id, capability: "files" as const } } : {}),
    });
    expect(
      manifestDeviceIds({
        effects: [at(OTHER_DEVICE), at(null), at(DEVICE), at(OTHER_DEVICE)] as never,
      }),
    ).toEqual([DEVICE, OTHER_DEVICE]);
  });
});
