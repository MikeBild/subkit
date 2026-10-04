export interface SettingsDraftSnapshot {
  partialFieldEdits: Record<string, unknown>;
  scrollTop: number;
  expandedKeys: string[];
}

interface StoreEntry extends SettingsDraftSnapshot {
  updated_at: number;
}

const store = new Map<string, StoreEntry>();

const EMPTY: SettingsDraftSnapshot = {
  partialFieldEdits: {},
  scrollTop: 0,
  expandedKeys: [],
};

function key(profile: string, tenant: string | null | undefined): string {
  return `${profile}|${tenant ?? "(no-tenant)"}`;
}

export function loadDraft(
  profile: string,
  tenant: string | null | undefined,
): SettingsDraftSnapshot {
  const entry = store.get(key(profile, tenant));
  if (!entry) return { ...EMPTY };
  return {
    partialFieldEdits: { ...entry.partialFieldEdits },
    scrollTop: entry.scrollTop,
    expandedKeys: entry.expandedKeys.slice(),
  };
}

export function saveDraft(
  profile: string,
  tenant: string | null | undefined,
  snap: SettingsDraftSnapshot,
): void {
  store.set(key(profile, tenant), { ...snap, updated_at: Date.now() });
}

export function clearDraft(profile: string, tenant: string | null | undefined): void {
  store.delete(key(profile, tenant));
}

export function _resetDraftStoreForTests(): void {
  store.clear();
}
