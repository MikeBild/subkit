export const DEVICE_VAULT_SCHEMA = "subkit-device-vault.v1";

export type DeviceVaultKind = "system" | "secret";

export interface DeviceVaultEntry {
  readonly kind: DeviceVaultKind;
  readonly sealed: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface DeviceVaultDocument {
  readonly schema: typeof DEVICE_VAULT_SCHEMA;
  readonly items: Readonly<Record<string, DeviceVaultEntry>>;
}

export interface DeviceVaultItemView {
  readonly name: string;
  readonly kind: DeviceVaultKind;
  readonly created_at: string;
  readonly updated_at: string;
  readonly removable: boolean;
}

const SYSTEM_PREFIXES = ["runner-key:", "local-engine:"] as const;

export function emptyDeviceVault(): DeviceVaultDocument {
  return { schema: DEVICE_VAULT_SCHEMA, items: {} };
}

export function deviceVaultKindOf(name: string): DeviceVaultKind {
  return SYSTEM_PREFIXES.some((prefix) => name.startsWith(prefix)) ? "system" : "secret";
}

function isEntry(value: unknown): value is DeviceVaultEntry {
  const entry = Object(value) as Record<string, unknown>;
  return (
    (entry.kind === "system" || entry.kind === "secret") &&
    typeof entry.sealed === "string" &&
    entry.sealed !== "" &&
    typeof entry.created_at === "string" &&
    typeof entry.updated_at === "string"
  );
}

export function parseDeviceVault(raw: unknown): DeviceVaultDocument {
  const document = Object(raw) as Record<string, unknown>;
  if (document.schema !== DEVICE_VAULT_SCHEMA || Array.isArray(document.items)) {
    return emptyDeviceVault();
  }
  const out: Record<string, DeviceVaultEntry> = {};
  for (const [name, entry] of Object.entries(Object(document.items))) {
    if (isEntry(entry)) out[name] = entry;
  }
  return { schema: DEVICE_VAULT_SCHEMA, items: out };
}

export function putDeviceVaultEntry(
  document: DeviceVaultDocument,
  name: string,
  sealed: string,
  now: string,
): DeviceVaultDocument {
  const previous = document.items[name];
  return {
    schema: DEVICE_VAULT_SCHEMA,
    items: {
      ...document.items,
      [name]: {
        kind: deviceVaultKindOf(name),
        sealed,
        created_at: previous?.created_at ?? now,
        updated_at: now,
      },
    },
  };
}

export function removeDeviceVaultEntry(
  document: DeviceVaultDocument,
  name: string,
): DeviceVaultDocument {
  if (!(name in document.items)) return document;
  const { [name]: _removed, ...rest } = document.items;
  return { schema: DEVICE_VAULT_SCHEMA, items: rest };
}

export function deviceVaultItems(document: DeviceVaultDocument): DeviceVaultItemView[] {
  return Object.entries(document.items)
    .map(([name, entry]) => ({
      name,
      kind: entry.kind,
      created_at: entry.created_at,
      updated_at: entry.updated_at,
      removable: entry.kind === "secret",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
