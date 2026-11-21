import type { DeviceBinding } from "./effect-manifest.ts";

export type DeviceGrowthKind =
  | "new_folder"
  | "wider_folder_access"
  | "new_site"
  | "private_site"
  | "new_app";

export interface DeviceGrowth {
  kind: DeviceGrowthKind;
  item: string;
}

export function deviceGrowth(
  next: DeviceBinding,
  granted: readonly (DeviceBinding | undefined)[],
): DeviceGrowth[] {
  const same = granted.filter(
    (binding): binding is DeviceBinding => binding?.device_id === next.device_id,
  );
  // Stryker disable next-line ArrayDeclaration: EQ-DEVICE-LISTS: a placeholder entry has no id or digest and never matches
  const folders = same.flatMap((binding) => binding.folders ?? []);
  // Stryker disable next-line ArrayDeclaration: EQ-DEVICE-LISTS: a placeholder entry has no origin or digest and never matches
  const sites = same.flatMap((binding) => binding.sites ?? []);
  // Stryker disable next-line ArrayDeclaration: EQ-DEVICE-LISTS: a placeholder entry has no id or digest and never matches
  const apps = same.flatMap((binding) => binding.apps ?? []);
  const growth: DeviceGrowth[] = [];
  for (const folder of next.folders ?? []) {
    const known = folders.filter(
      (candidate) =>
        candidate.folder_id === folder.folder_id && candidate.root_digest === folder.root_digest,
    );
    if (known.length === 0) growth.push({ kind: "new_folder", item: folder.folder_id });
    else if (folder.access === "write" && known.every((candidate) => candidate.access === "read"))
      growth.push({ kind: "wider_folder_access", item: folder.folder_id });
  }
  for (const site of next.sites ?? []) {
    const known = sites.some(
      (candidate) => candidate.origin === site.origin && candidate.site_digest === site.site_digest,
    );
    if (!known)
      growth.push({ kind: site.private ? "private_site" : "new_site", item: site.origin });
  }
  for (const app of next.apps ?? []) {
    const known = apps.some(
      (candidate) => candidate.app_id === app.app_id && candidate.app_digest === app.app_digest,
    );
    if (!known) growth.push({ kind: "new_app", item: app.app_id });
  }
  return growth;
}
