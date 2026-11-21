import { afterAll, beforeAll, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  browserSessionCookie,
  signBrowserCsrf,
  signBrowserSession,
} from "../../auth/browser-session.ts";
import {
  cockpitInstallations,
  connectors,
  deviceAllowances,
  deviceRunners,
  sessions,
  workflowExecutionAuthorities,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { revokeDeviceRunnersForInstallation } from "../../devices/registry.ts";
import { grantWorkflowAuthority, previewWorkflowAuthority } from "../execution-authorities.ts";
import { executionAuthoritiesFixtures } from "./execution-authorities-fixtures.ts";

const DEVICE = "66666666-6666-4666-8666-666666666666";

let ctx: TestDb;

const { fixture } = executionAuthoritiesFixtures({
  get ctx() {
    return ctx;
  },
});

beforeAll(async () => {
  ctx = await createTestDb("authority_device");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function deviceWorkflow(device_id = DEVICE) {
  return bindDevice(await fixture(), device_id);
}

async function bindDevice(f: Awaited<ReturnType<typeof fixture>>, device_id: string) {
  const [connector] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: f.workflow.tenant_id,
      slug: `this-mac-files-${f.workflow.slug}`,
      display_name: "This Mac: files",
      driver: "local_files",
      auth_type: "none",
      environment: "dev",
      config: { device_id },
    })
    .returning();
  if (!connector) throw new Error("missing device connector fixture");
  await ctx.db
    .update(workflowVersions)
    .set({
      dag: {
        name: f.workflow.name,
        steps: [
          {
            id: "summary",
            kind: "request",
            connector_id: connector.id,
            method: "POST",
            path: "/files.write",
            body: { folder_id: "berichte", relative_path: "woche.md", text: "ok" },
          },
        ],
      },
    })
    .where(eq(workflowVersions.id, f.version.id));
  const preview = await previewWorkflowAuthority(
    {
      tenant_id: f.workflow.tenant_id,
      workflow_id: f.workflow.id,
      workflow_version_id: f.version.id,
      execution_environment: "dev",
    },
    ctx.db,
  );
  return {
    ...f,
    connector,
    preview,
    input: { ...f.input, expected_manifest_digest: preview.digest },
  };
}

async function authorities(workflow_id: string, tenant_id: string) {
  return ctx.db
    .select({ id: workflowExecutionAuthorities.id })
    .from(workflowExecutionAuthorities)
    .where(
      and(
        eq(workflowExecutionAuthorities.tenant_id, tenant_id),
        eq(workflowExecutionAuthorities.workflow_id, workflow_id),
      ),
    );
}

test("a folder the device has not allowed keeps the approval out of reach", async () => {
  const f = await deviceWorkflow();
  expect(f.preview.manifest.effects[0]).toMatchObject({
    driver: "local_files",
    device: { device_id: DEVICE, capability: "files" },
    target: `device:${DEVICE}/files`,
  });
  expect(Object.keys(f.preview.manifest.effects[0]?.device ?? {}).sort()).toEqual([
    "capability",
    "device_id",
  ]);
  expect(f.preview.eligible_for_repeated_runs).toBe(false);
  await expect(grantWorkflowAuthority(f.workflow.id, f.input, f.context)).rejects.toMatchObject({
    code: "authority_effect_unbound",
  });
  expect(await authorities(f.workflow.id, f.workflow.tenant_id)).toEqual([]);
});

test("the approval names the folder the step writes, with the digest the device allowed", async () => {
  const base = await fixture();
  const device = await enrolledDevice(base);
  const f = await bindDevice(base, device.runner.id);
  expect(f.preview.eligible_for_repeated_runs).toBe(true);
  expect(f.preview.manifest.effects[0]?.device).toEqual({
    device_id: device.runner.id,
    capability: "files",
    folders: [{ folder_id: "berichte", access: "write", root_digest: ROOT_DIGEST }],
  });
});

test("a folder allowed only for reading does not cover a write", async () => {
  const base = await fixture();
  const device = await enrolledDevice(base, "read");
  const f = await bindDevice(base, device.runner.id);
  expect(f.preview.eligible_for_repeated_runs).toBe(false);
});

test("a workflow without a device is still approved from any browser", async () => {
  const f = await fixture();
  const authority = await grantWorkflowAuthority(f.workflow.id, f.input, f.context);
  expect(authority.effect_manifest_digest).toBe(f.input.expected_manifest_digest);
});

let deviceCounter = 0;
const ROOT_DIGEST = "a".repeat(64);

async function enrolledDevice(
  f: Awaited<ReturnType<typeof fixture>>,
  access: "read" | "write" = "write",
) {
  const tenant_id = f.workflow.tenant_id;
  const user_id = f.context.principal.id;
  const [installation] = await ctx.db
    .insert(cockpitInstallations)
    .values({
      tenant_id,
      owner_user_id: user_id,
      kind: "desktop",
      device_id: `e1000000-0000-4000-8000-${String(++deviceCounter).padStart(12, "0")}`,
      device_label: "MacBook Pro (Mike)",
    })
    .returning();
  if (!installation) throw new Error("missing installation fixture");
  const [runner] = await ctx.db
    .insert(deviceRunners)
    .values({
      tenant_id,
      installation_id: installation.id,
      owner_user_id: user_id,
      device_label: "MacBook Pro (Mike)",
      public_key: generateKeyPairSync("ed25519")
        .publicKey.export({ type: "spki", format: "pem" })
        .toString(),
    })
    .returning();
  if (!runner) throw new Error("missing runner fixture");
  await ctx.db.insert(deviceAllowances).values({
    tenant_id,
    device_runner_id: runner.id,
    kind: "folder",
    item_id: "berichte",
    display: "~/Documents/Berichte",
    digest: ROOT_DIGEST,
    access,
    entered_by: "person",
  });
  const [session] = await ctx.db
    .insert(sessions)
    .values({
      tenant_id,
      user_id,
      installation_id: installation.id,
      expires_at: f.session.expires_at,
      absolute_expires_at: f.session.absolute_expires_at,
    })
    .returning();
  if (!session) throw new Error("missing device session fixture");
  const payload = {
    tenant_id,
    user_id,
    session_id: session.id,
    installation_id: installation.id,
  };
  const context = {
    db: ctx.db,
    principal: {
      ...f.context.principal,
      session_id: session.id,
      installation_id: installation.id,
    },
    request: new Request(
      `https://example.test/cockpit/i/${installation.id}/api/v1/workflows/authority`,
      {
        method: "POST",
        headers: {
          cookie: browserSessionCookie(
            await signBrowserSession(payload),
            undefined,
            installation.id,
          ),
          "x-subkit-csrf": await signBrowserCsrf(payload),
        },
      },
    ),
  };
  return { installation, runner, context };
}

test("the device's own desktop session approves a workflow bound to it", async () => {
  const base = await fixture();
  const device = await enrolledDevice(base);
  const f = await bindDevice(base, device.runner.id);
  const authority = await grantWorkflowAuthority(f.workflow.id, f.input, device.context);
  expect(authority.effect_manifest_digest).toBe(f.preview.digest);
});

test("any other session is sent to the device", async () => {
  const base = await fixture();
  const device = await enrolledDevice(base);
  const f = await bindDevice(base, device.runner.id);
  await expect(grantWorkflowAuthority(f.workflow.id, f.input, f.context)).rejects.toMatchObject({
    code: "device_approval_elsewhere",
  });
  expect(await authorities(f.workflow.id, f.workflow.tenant_id)).toEqual([]);
});

test("a revoked device can no longer be approved, and enrolling again names a new device", async () => {
  const base = await fixture();
  const device = await enrolledDevice(base);
  const f = await bindDevice(base, device.runner.id);
  await ctx.db.transaction((tx) =>
    revokeDeviceRunnersForInstallation(tx, {
      tenant_id: device.runner.tenant_id,
      installation_id: device.installation.id,
      actor_id: null,
      reason: "revoked",
    }),
  );
  await expect(
    grantWorkflowAuthority(f.workflow.id, f.input, device.context),
  ).rejects.toMatchObject({
    code: "device_unavailable",
  });
  const [again] = await ctx.db
    .insert(deviceRunners)
    .values({
      tenant_id: device.runner.tenant_id,
      installation_id: device.installation.id,
      owner_user_id: device.runner.owner_user_id,
      device_label: device.runner.device_label,
      public_key: device.runner.public_key,
    })
    .returning({ id: deviceRunners.id });
  expect(again?.id).not.toBe(device.runner.id);
  await expect(
    grantWorkflowAuthority(f.workflow.id, f.input, device.context),
  ).rejects.toMatchObject({
    code: "device_unavailable",
  });
});
