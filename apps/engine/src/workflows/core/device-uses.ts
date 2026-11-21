import type {
  DeviceBoundaryApp,
  DeviceBoundaryFolder,
  DeviceBoundarySite,
} from "@shared/device/boundary.ts";

export interface DeviceUses {
  folders: { folder_id: string; access: "read" | "write" }[];
  origins: string[];
  apps: string[];
  dynamic: boolean;
}

export interface DeviceAllowanceView {
  kind: "folder" | "site" | "app" | "keep_out";
  item_id: string;
  display: string;
  digest: string | null;
  access: "read" | "write" | null;
  private: boolean | null;
}

export interface DeviceLists {
  folders?: DeviceBoundaryFolder[];
  sites?: DeviceBoundarySite[];
  apps?: DeviceBoundaryApp[];
}

const FOLDER_KEYS = ["folder_id", "to_folder_id"] as const;

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function origin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

const READ_FOLDER_PATHS: ReadonlySet<string> = new Set(["files.import"]);

export function deviceUsesOf(
  step: { method: string; path?: string | undefined; body?: unknown },
  capability: "files" | "browser" | "computer",
): DeviceUses {
  const body = Object(step.body ?? {}) as Record<string, unknown>;
  const uses: DeviceUses = { folders: [], origins: [], apps: [], dynamic: false };
  const add = (value: string | null, push: (item: string) => void) => {
    if (value === null) return;
    if (value.includes("${")) uses.dynamic = true;
    else push(value);
  };
  const reads =
    step.method === "GET" || READ_FOLDER_PATHS.has(String(step.path).replace(/^\/+/, ""));
  const access = reads ? "read" : "write";
  for (const key of FOLDER_KEYS)
    add(text(body[key]), (folder_id) => uses.folders.push({ folder_id, access }));
  if (capability === "browser")
    add(text(body.url), (url) => {
      const found = origin(url);
      if (found === null) uses.dynamic = true;
      else uses.origins.push(found);
    });
  if (capability === "computer") add(text(body.app_id), (app_id) => uses.apps.push(app_id));
  return uses;
}

function byKey<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const item of items) seen.set(key(item), item);
  return [...seen.keys()].sort().map((id) => seen.get(id) as T);
}

export function deviceListsFor(
  uses: DeviceUses,
  allowances: readonly DeviceAllowanceView[],
): { lists: DeviceLists; complete: boolean } {
  let complete = !uses.dynamic;
  const allowed = (kind: DeviceAllowanceView["kind"], item_id: string) =>
    allowances.find((entry) => entry.kind === kind && entry.item_id === item_id && entry.digest);
  const folderAccess = new Map<string, "read" | "write">();
  for (const use of uses.folders)
    folderAccess.set(
      use.folder_id,
      folderAccess.get(use.folder_id) === "write" ? "write" : use.access,
    );
  const folders: DeviceBoundaryFolder[] = [];
  for (const [folder_id, access] of folderAccess) {
    const entry = allowed("folder", folder_id);
    if (!entry || (access === "write" && entry.access !== "write")) complete = false;
    else folders.push({ folder_id, access, root_digest: entry.digest as string });
  }
  const sites: DeviceBoundarySite[] = [];
  for (const found of uses.origins) {
    const entry = allowances.find(
      (candidate) => candidate.kind === "site" && candidate.display === found && candidate.digest,
    );
    if (!entry) complete = false;
    else
      sites.push({
        origin: found,
        private: entry.private === true,
        site_digest: entry.digest as string,
      });
  }
  const apps: DeviceBoundaryApp[] = [];
  for (const app_id of uses.apps) {
    const entry = allowed("app", app_id);
    if (!entry) complete = false;
    else apps.push({ app_id, app_digest: entry.digest as string });
  }
  const lists: DeviceLists = {};
  if (folders.length > 0) lists.folders = byKey(folders, (item) => item.folder_id);
  if (sites.length > 0) lists.sites = byKey(sites, (item) => item.origin);
  if (apps.length > 0) lists.apps = byKey(apps, (item) => item.app_id);
  return { lists, complete };
}

export function deviceListsCanonical(lists: {
  folders?: DeviceBoundaryFolder[] | undefined;
  sites?: DeviceBoundarySite[] | undefined;
  apps?: DeviceBoundaryApp[] | undefined;
}): boolean {
  const sortedUnique = (keys: string[]) =>
    keys.every((key, index) => index === 0 || (keys[index - 1] as string) < key);
  return (
    (lists.folders === undefined ||
      (lists.folders.length > 0 && sortedUnique(lists.folders.map((item) => item.folder_id)))) &&
    (lists.sites === undefined ||
      (lists.sites.length > 0 && sortedUnique(lists.sites.map((item) => item.origin)))) &&
    (lists.apps === undefined ||
      (lists.apps.length > 0 && sortedUnique(lists.apps.map((item) => item.app_id))))
  );
}
