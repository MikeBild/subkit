import { createHash } from "node:crypto";
import type { DeviceBoundarySite } from "@shared/device/boundary.ts";
import type { DeviceCommand } from "@shared/device/protocol.ts";
import { normalizeOrigin, type SiteAllowanceLike } from "@shared/local-policy/addresses.ts";
import { isCredentialField } from "@shared/local-policy/commit-classifier.ts";
import { type ProxySiteRules, siteModeFor } from "@shared/local-policy/proxy-decision.ts";
import { REDACTION_PADDING, type Rect } from "@shared/local-policy/redaction-rects.ts";
import { z } from "zod";

export interface BrowserAllowances {
  readonly sites: readonly SiteAllowanceLike[];
}

function originOf(value: string): string | null {
  return normalizeOrigin(value)?.origin ?? null;
}

function listedIn(origin: string | null, list: readonly string[]): boolean {
  return origin !== null && list.some((entry) => originOf(entry) === origin);
}

export function siteRulesFor(
  command: Pick<DeviceCommand, "execution_id">,
  boundarySites: readonly DeviceBoundarySite[] | undefined,
  allowances: BrowserAllowances,
): ProxySiteRules | null {
  const mode = siteModeFor(command.execution_id, boundarySites);
  if (mode === "outside_boundary") return null;
  if (mode === "workflow") {
    const approved = (boundarySites ?? []).map((site) => site.origin);
    return {
      mode: "workflow",
      sites: allowances.sites.filter((site) => listedIn(originOf(site.origin), approved)),
    };
  }
  return {
    mode: "personal",
    options: {
      entered_by_person: allowances.sites
        .filter((site) => site.entered_by === "person")
        .map((site) => site.origin),
    },
  };
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface PageState {
  readonly origin: string | null;
  readonly title_sha256: string | null;
}

export function pageState(url: string | null, title: string | null): PageState {
  return {
    origin: url === null ? null : originOf(url),
    title_sha256: title === null ? null : sha256Hex(title),
  };
}

export function stateVersion(state: PageState): string {
  return `page:${sha256Hex(JSON.stringify([state.origin, state.title_sha256]))}`;
}

export function textOf(data: unknown, keys: readonly string[]): string | null {
  if (typeof data === "string") return data;
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
    if (value === null) return null;
  }
  return null;
}

export const FIELD_SCAN_SCRIPT = `JSON.stringify((() => {
  const fields = [];
  let focusUnknown = false;
  let focused = document.activeElement;
  for (let hops = 0; focused && hops < 16; hops += 1) {
    if (focused.shadowRoot && focused.shadowRoot.activeElement) {
      focused = focused.shadowRoot.activeElement;
    } else if (focused.tagName === "IFRAME" || focused.tagName === "FRAME") {
      let inner = null;
      try { inner = focused.contentDocument; } catch (error) { inner = null; }
      if (!inner) { focusUnknown = true; break; }
      focused = inner.activeElement;
    } else break;
  }
  const visit = (root, dx, dy, depth) => {
    if (depth > 8 || fields.length >= 5000) return;
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) visit(el.shadowRoot, dx, dy, depth + 1);
      if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
        let inner = null;
        try { inner = el.contentDocument; } catch (error) { inner = null; }
        const box = el.getBoundingClientRect();
        if (inner) visit(inner, dx + box.x + el.clientLeft, dy + box.y + el.clientTop, depth + 1);
      }
      if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") continue;
      const r = el.getBoundingClientRect();
      fields.push({
        type: (el.getAttribute("type") || "").toLowerCase(),
        autocomplete: (el.getAttribute("autocomplete") || "").toLowerCase(),
        focused: el === focused,
        x: dx + r.x, y: dy + r.y, width: r.width, height: r.height,
      });
    }
  };
  visit(document, 0, 0, 0);
  return { dpr: window.devicePixelRatio || 1, focus_unknown: focusUnknown, fields: fields.slice(0, 5000) };
})())`;

const FieldSchema = z.object({
  type: z.string(),
  autocomplete: z.string(),
  focused: z.boolean(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

const ScanSchema = z.object({
  dpr: z.number().positive().max(8),
  focus_unknown: z.boolean().default(false),
  fields: z.array(FieldSchema).max(5000),
});

export type FieldScan =
  | { readonly ok: true; readonly secure_focus: boolean; readonly rects: readonly Rect[] }
  | { readonly ok: false };

function decoded(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function candidates(data: unknown): unknown[] {
  if (typeof data !== "object" || data === null) return [decoded(data)];
  const record = data as Record<string, unknown>;
  return [data, decoded(record.result), decoded(record.value)];
}

export function parseFieldScan(data: unknown): FieldScan {
  for (const candidate of candidates(data)) {
    const parsed = ScanSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const { dpr, fields, focus_unknown } = parsed.data;
    const secure = fields.filter((field) =>
      isCredentialField({ input_type: field.type, autocomplete: field.autocomplete }),
    );
    return {
      ok: true,
      secure_focus: focus_unknown || secure.some((field) => field.focused),
      rects: secure
        .filter((field) => field.width > 0 && field.height > 0)
        .map((field) => ({
          x: (field.x - REDACTION_PADDING) * dpr,
          y: (field.y - REDACTION_PADDING) * dpr,
          width: (field.width + 2 * REDACTION_PADDING) * dpr,
          height: (field.height + 2 * REDACTION_PADDING) * dpr,
        })),
    };
  }
  return { ok: false };
}
