import { createHash } from "node:crypto";
import { appDigestMaterial, type DeviceSubBoundary } from "@shared/device/boundary.ts";
import {
  DEVICE_OS,
  type DeviceCommand,
  type DeviceCommandKind,
  type DeviceRefusal,
} from "@shared/device/protocol.ts";
import { classifyApp, computerActionAllowed } from "@shared/local-policy/blocked-apps.ts";
import { z } from "zod";
import { type Permissions, permissionGranted } from "./permission-model.ts";

const MAC = DEVICE_OS[0];

export const COMPUTER_APPS_MAX = 20;
export const COMPUTER_KEEP_OUT_MAX = 100;

const BundleIdSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/);

export const ComputerAppSchema = z
  .object({
    bundle_id: BundleIdSchema,
    team_id: z
      .string()
      .regex(/^[A-Z0-9]{10}$/)
      .nullable(),
    display: z.string().min(1).max(200),
  })
  .strict();
export type ComputerApp = z.infer<typeof ComputerAppSchema>;

export const ComputerKeepOutSchema = z
  .object({ bundle_id: BundleIdSchema, display: z.string().min(1).max(200) })
  .strict();
export type ComputerKeepOut = z.infer<typeof ComputerKeepOutSchema>;

export const ComputerPermissionsSchema = z
  .object({ accessibility: z.boolean(), screen: z.boolean() })
  .strict();
export type ComputerPermissions = z.infer<typeof ComputerPermissionsSchema>;

export const ComputerSnapshotSchema = z
  .object({
    enabled: z.boolean(),
    personal_enabled: z.boolean(),
    apps: z.array(ComputerAppSchema).max(COMPUTER_APPS_MAX),
    keep_out: z.array(ComputerKeepOutSchema).max(COMPUTER_KEEP_OUT_MAX),
    permissions: ComputerPermissionsSchema,
    helper: z
      .object({ path: z.string().startsWith("/"), state_root: z.string().startsWith("/") })
      .strict()
      .nullable(),
  })
  .strict();
export type ComputerSnapshot = z.infer<typeof ComputerSnapshotSchema>;

export function computerPermissions(permissions: Permissions): ComputerPermissions {
  return {
    accessibility: permissionGranted(permissions, "accessibility"),
    screen: permissionGranted(permissions, "screen"),
  };
}

export const COMPUTER_OFF: ComputerSnapshot = {
  enabled: false,
  personal_enabled: false,
  apps: [],
  keep_out: [],
  permissions: { accessibility: false, screen: false },
  helper: null,
};

export function parseComputerSnapshot(raw: unknown): ComputerSnapshot {
  const parsed = ComputerSnapshotSchema.safeParse(raw);
  return parsed.success ? parsed.data : COMPUTER_OFF;
}

function sameBundle(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export type AllowanceChange =
  | { readonly ok: true; readonly snapshot: ComputerSnapshot }
  | { readonly ok: false; readonly code: "blocked_app" | "keep_out" | "duplicate" | "full" };

export function addApp(snapshot: ComputerSnapshot, app: ComputerApp): AllowanceChange {
  if (classifyApp(app.bundle_id, app.display, MAC).access === "blocked") {
    return { ok: false, code: "blocked_app" };
  }
  if (snapshot.keep_out.some((entry) => sameBundle(entry.bundle_id, app.bundle_id))) {
    return { ok: false, code: "keep_out" };
  }
  if (snapshot.apps.some((entry) => sameBundle(entry.bundle_id, app.bundle_id))) {
    return { ok: false, code: "duplicate" };
  }
  if (snapshot.apps.length >= COMPUTER_APPS_MAX) return { ok: false, code: "full" };
  return { ok: true, snapshot: { ...snapshot, apps: [...snapshot.apps, app] } };
}

export function addKeepOut(snapshot: ComputerSnapshot, entry: ComputerKeepOut): AllowanceChange {
  if (snapshot.keep_out.some((known) => sameBundle(known.bundle_id, entry.bundle_id))) {
    return { ok: false, code: "duplicate" };
  }
  if (snapshot.keep_out.length >= COMPUTER_KEEP_OUT_MAX) return { ok: false, code: "full" };
  return {
    ok: true,
    snapshot: {
      ...snapshot,
      apps: snapshot.apps.filter((app) => !sameBundle(app.bundle_id, entry.bundle_id)),
      keep_out: [...snapshot.keep_out, entry],
    },
  };
}

export function removeApp(snapshot: ComputerSnapshot, bundleId: string): ComputerSnapshot {
  return { ...snapshot, apps: snapshot.apps.filter((app) => !sameBundle(app.bundle_id, bundleId)) };
}

export function appDigest(deviceId: string, app: ComputerApp): string {
  return createHash("sha256")
    .update(
      appDigestMaterial({ device_id: deviceId, bundle_id: app.bundle_id, team_id: app.team_id }),
    )
    .digest("hex");
}

export interface RunningApp {
  readonly bundle_id: string | null;
  readonly name: string | null;
}

export type AppVerdict =
  | { readonly ok: true; readonly app: ComputerApp }
  | { readonly ok: false; readonly code: DeviceRefusal };

function deny(code: DeviceRefusal): AppVerdict {
  return { ok: false, code };
}

export function appAccess(snapshot: ComputerSnapshot, running: RunningApp): AppVerdict {
  const access = classifyApp(running.bundle_id, running.name, MAC).access;
  if (access === "blocked") return deny("blocked_app");
  const bundleId = running.bundle_id;
  if (bundleId === null) return deny("outside_allowance");
  if (snapshot.keep_out.some((entry) => sameBundle(entry.bundle_id, bundleId))) {
    return deny("outside_allowance");
  }
  const app = snapshot.apps.find((entry) => sameBundle(entry.bundle_id, bundleId));
  return app ? { ok: true, app } : deny("outside_allowance");
}

export type ComputerMode = "workflow" | "personal";

export function modeOf(command: Pick<DeviceCommand, "execution_id">): ComputerMode {
  return command.execution_id !== null ? "workflow" : "personal";
}

export function computerClosed(
  snapshot: ComputerSnapshot,
  command: Pick<DeviceCommand, "execution_id">,
): boolean {
  if (!snapshot.enabled || snapshot.helper === null) return true;
  return modeOf(command) === "personal" && !snapshot.personal_enabled;
}

export function computerOffered(snapshot: ComputerSnapshot): boolean {
  return (
    snapshot.enabled &&
    snapshot.helper !== null &&
    snapshot.permissions.accessibility &&
    snapshot.permissions.screen
  );
}

export interface TargetInput {
  readonly kind: DeviceCommandKind;
  readonly mode: ComputerMode;
  readonly device_id: string;
  readonly snapshot: ComputerSnapshot;
  readonly boundary: DeviceSubBoundary | undefined;
  readonly target: RunningApp;
}

function boundaryCovers(input: TargetInput, app: ComputerApp): boolean {
  const boundary = input.boundary;
  if (!boundary || boundary.device_id !== input.device_id) return false;
  if (boundary.capability !== "computer") return false;
  const bound = boundary.apps?.find((entry) => entry.app_id === app.bundle_id);
  return bound !== undefined && bound.app_digest === appDigest(input.device_id, app);
}

export function targetVerdict(input: TargetInput): AppVerdict {
  if (!input.snapshot.enabled) return deny("outside_allowance");
  if (!input.snapshot.permissions.accessibility) return deny("permission_missing");
  if (input.kind === "computer.screenshot" && !input.snapshot.permissions.screen) {
    return deny("permission_missing");
  }
  const access = classifyApp(input.target.bundle_id, input.target.name, MAC).access;
  if (!computerActionAllowed(input.kind, access)) return deny("blocked_app");
  const verdict = appAccess(input.snapshot, input.target);
  if (!verdict.ok) return verdict;
  if (input.mode === "workflow" && !boundaryCovers(input, verdict.app)) {
    return deny("outside_boundary");
  }
  return verdict;
}

export function frontmostVerdict(
  snapshot: ComputerSnapshot,
  frontmost: RunningApp | null,
): AppVerdict {
  if (frontmost === null) return deny("outside_allowance");
  return appAccess(snapshot, frontmost);
}

const OBSERVING: ReadonlySet<DeviceCommandKind> = new Set([
  "computer.apps",
  "computer.snapshot",
  "computer.find",
  "computer.screenshot",
]);

export function isActing(kind: DeviceCommandKind): boolean {
  return !OBSERVING.has(kind);
}
