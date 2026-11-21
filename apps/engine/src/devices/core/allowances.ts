import type { DeviceAllowance } from "@shared/device/boundary.ts";

export const DEVICE_ALLOWANCES_MAX = 500;

export interface AllowanceRow {
  kind: DeviceAllowance["kind"];
  item_id: string;
  display: string;
  digest: string | null;
  access: "read" | "write" | null;
  private: boolean | null;
  keep_out_target: "folder" | "app" | null;
  entered_by: "person" | "approval";
}

export function allowanceRow(allowance: DeviceAllowance): AllowanceRow {
  const base = { kind: allowance.kind, item_id: allowance.id, entered_by: allowance.entered_by };
  switch (allowance.kind) {
    case "folder":
      return {
        ...base,
        display: allowance.display,
        digest: allowance.digest,
        access: allowance.access,
        private: null,
        keep_out_target: null,
      };
    case "site":
      return {
        ...base,
        display: allowance.origin,
        digest: allowance.digest,
        access: null,
        private: allowance.private,
        keep_out_target: null,
      };
    case "app":
      return {
        ...base,
        display: allowance.display,
        digest: allowance.digest,
        access: null,
        private: null,
        keep_out_target: null,
      };
    case "keep_out":
      return {
        ...base,
        display: allowance.display,
        digest: null,
        access: null,
        private: null,
        keep_out_target: allowance.target,
      };
  }
}

function key(row: Pick<AllowanceRow, "kind" | "item_id">): string {
  return `${row.kind}\u0000${row.item_id}`;
}

function same(a: AllowanceRow, b: AllowanceRow): boolean {
  return (
    a.display === b.display &&
    a.digest === b.digest &&
    a.access === b.access &&
    a.private === b.private &&
    a.keep_out_target === b.keep_out_target &&
    a.entered_by === b.entered_by
  );
}

export type AllowanceDiff =
  | { ok: true; added: AllowanceRow[]; removed: AllowanceRow[] }
  | {
      ok: false;
      code: "allowances_duplicate" | "allowances_too_many" | "private_site_needs_person";
    };

export function diffAllowances(
  current: readonly AllowanceRow[],
  next: readonly DeviceAllowance[],
): AllowanceDiff {
  if (next.length > DEVICE_ALLOWANCES_MAX) return { ok: false, code: "allowances_too_many" };
  const wanted = new Map<string, AllowanceRow>();
  for (const allowance of next) {
    const row = allowanceRow(allowance);
    if (row.private === true && row.entered_by !== "person")
      return { ok: false, code: "private_site_needs_person" };
    if (wanted.has(key(row))) return { ok: false, code: "allowances_duplicate" };
    wanted.set(key(row), row);
  }
  const existing = new Map(current.map((row) => [key(row), row]));
  const removed = current.filter((row) => {
    const replacement = wanted.get(key(row));
    return !replacement || !same(row, replacement);
  });
  const added = [...wanted.values()].filter((row) => {
    const prior = existing.get(key(row));
    return !prior || !same(prior, row);
  });
  return { ok: true, added, removed };
}

export const ALLOWANCE_AUDIT_ACTIONS = {
  added: {
    folder: "device.folder_allowed",
    site: "device.site_allowed",
    app: "device.app_allowed",
    keep_out: "device.keep_out_added",
  },
  removed: {
    folder: "device.folder_removed",
    site: "device.site_removed",
    app: "device.app_removed",
    keep_out: "device.keep_out_removed",
  },
} as const;
