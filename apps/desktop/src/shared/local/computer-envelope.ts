import type { DeviceRefusal } from "@shared/device/protocol.ts";
import type { Rect } from "@shared/local-policy/redaction-rects.ts";
import { z } from "zod";
import type { RunningApp } from "./computer-allowances.ts";
import { RectSchema } from "./computer-tree.ts";

export const HELPER_CONTRACT_VERSION = "2.6";

const DispositionSchema = z.looseObject({ delivery: z.string(), retry: z.string().optional() });

const ErrorSchema = z.looseObject({
  code: z.string(),
  message: z.string().optional(),
  details: z.unknown().optional(),
  disposition: DispositionSchema.optional(),
});

const EnvelopeSchema = z.looseObject({
  version: z.string(),
  ok: z.boolean(),
  command: z.string(),
  data: z.unknown().optional(),
  error: ErrorSchema.optional(),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;
export type HelperError = z.infer<typeof ErrorSchema>;

export type ParsedEnvelope =
  | { readonly ok: true; readonly envelope: Envelope }
  | { readonly ok: false; readonly reason: "not_json" | "shape" | "version" };

export function parseEnvelope(stdout: string): ParsedEnvelope {
  const lines = stdout.trim().split("\n");
  const line = lines[lines.length - 1] as string;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, reason: "not_json" };
  }
  const parsed = EnvelopeSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "shape" };
  if (parsed.data.version !== HELPER_CONTRACT_VERSION) return { ok: false, reason: "version" };
  if (parsed.data.ok ? parsed.data.data === undefined : parsed.data.error === undefined) {
    return { ok: false, reason: "shape" };
  }
  return { ok: true, envelope: parsed.data };
}

export type ErrorVerdict =
  | { readonly kind: "refused"; readonly code: DeviceRefusal }
  | { readonly kind: "failed"; readonly code: string };

const STALE_CODES = new Set([
  "STALE_REF",
  "SNAPSHOT_NOT_FOUND",
  "AMBIGUOUS_TARGET",
  "WINDOW_NOT_FOUND",
  "ELEMENT_NOT_FOUND",
  "APP_NOT_FOUND",
]);

export function errorVerdict(error: HelperError, command: string): ErrorVerdict {
  if (error.disposition?.delivery !== "not_delivered") {
    return { kind: "failed", code: "delivery_uncertain" };
  }
  if (error.code === "PERM_DENIED") return { kind: "refused", code: "permission_missing" };
  if (STALE_CODES.has(error.code)) return { kind: "refused", code: "stale" };
  if (error.code === "POLICY_DENIED" && command === "press") {
    return { kind: "refused", code: "blocked_shortcut" };
  }
  return { kind: "failed", code: `helper_${error.code.toLowerCase()}` };
}

export function touchedSecureField(data: unknown): boolean {
  const details = (data as { details?: { verification_reason?: unknown } } | null)?.details;
  return details?.verification_reason === "secure_field";
}

const WindowSchema = z.looseObject({
  id: z.string().min(1),
  app_name: z.string(),
  pid: z.number().int(),
  title: z.string().nullable().optional(),
  bounds: RectSchema.nullable().optional(),
  is_focused: z.boolean().optional(),
});

const AppSchema = z.looseObject({
  bundle_id: z.string().nullable().optional(),
  name: z.string(),
  pid: z.number().int(),
});

const AppsDataSchema = z.looseObject({ apps: z.array(AppSchema) });

export interface InventoryWindow {
  readonly id: string;
  readonly app: RunningApp;
  readonly title: string;
  readonly bounds: Rect | null;
  readonly focused: boolean;
}

export function inventoryOf(windowsData: unknown, appsData: unknown): InventoryWindow[] | null {
  const windows = z.array(WindowSchema).safeParse(windowsData);
  const apps = AppsDataSchema.safeParse(appsData);
  if (!windows.success || !apps.success) return null;
  const byPid = new Map(apps.data.apps.map((app) => [app.pid, app]));
  return windows.data.map((window) => {
    const app = byPid.get(window.pid);
    return {
      id: window.id,
      app: { bundle_id: app?.bundle_id ?? null, name: app?.name ?? window.app_name },
      title: window.title ?? "",
      bounds: window.bounds ?? null,
      focused: window.is_focused === true,
    };
  });
}

export function frontmostWindow(windows: readonly InventoryWindow[]): InventoryWindow | null {
  return windows.find((window) => window.focused) ?? null;
}

const SnapshotDataSchema = z.looseObject({
  snapshot_id: z.string().min(1),
  complete: z.boolean(),
  tree: z.unknown(),
});

export const ScreenshotDataSchema = z.looseObject({
  format: z.literal("png"),
  data: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  scale_factor: z.number().positive(),
});
export type ScreenshotData = z.infer<typeof ScreenshotDataSchema>;

export function snapshotData(
  data: unknown,
): { snapshot_id: string; complete: boolean; tree: unknown } | null {
  const parsed = SnapshotDataSchema.safeParse(data);
  if (!parsed.success) return null;
  return {
    snapshot_id: parsed.data.snapshot_id,
    complete: parsed.data.complete,
    tree: parsed.data.tree,
  };
}

export function screenshotData(data: unknown): ScreenshotData | null {
  const parsed = ScreenshotDataSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}
