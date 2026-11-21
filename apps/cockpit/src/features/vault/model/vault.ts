import type { components } from "@cli-core/engine-api/openapi";
import type { TranslationKey } from "@/lib/i18n";

export type VaultItem = components["schemas"]["VaultItem"];
export type VaultItemCreate = components["schemas"]["VaultItemCreate"];
export type VaultItemUpdate = components["schemas"]["VaultItemUpdate"];
export type VaultActivityEntry = components["schemas"]["VaultItemActivity"]["items"][number];
export type VaultKind = VaultItem["kind"];
export type VaultScope = VaultItem["scope"];
export type VaultEnvironment = VaultItem["environment"];
export type VaultEntryKind = VaultItemCreate["kind"];
export type VaultAction = "read" | "write" | "rotate" | "delete" | "reveal";

export const VAULT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export const VAULT_RESERVED_NAME = "me";
export const REVEAL_SECONDS = 30;

export const VAULT_KINDS: readonly VaultKind[] = [
  "secret",
  "login",
  "connector",
  "template_client",
];

export const VAULT_KIND_LABEL: Readonly<Record<VaultKind, TranslationKey>> = {
  secret: "vault.kind.secret",
  login: "vault.kind.login",
  connector: "vault.kind.connector",
  template_client: "vault.kind.template_client",
};

export const VAULT_SCOPE_LABEL: Readonly<Record<VaultScope, TranslationKey>> = {
  workspace: "vault.scope.workspace",
  person: "vault.scope.person",
};

const FIELD_LABEL: Readonly<Record<string, TranslationKey>> = {
  token: "vault.field.token",
  username: "vault.field.username",
  password: "vault.field.password",
};

export type VaultNameProblem = "empty" | "reserved" | "invalid";

const NAME_PROBLEM_KEY: Readonly<Record<VaultNameProblem, TranslationKey>> = {
  empty: "vault.name.empty",
  reserved: "vault.name.reserved",
  invalid: "vault.name.invalid",
};

export function vaultNameProblem(raw: string): VaultNameProblem | null {
  const name = raw.trim();
  if (name === "") return "empty";
  if (name === VAULT_RESERVED_NAME) return "reserved";
  return VAULT_NAME_PATTERN.test(name) ? null : "invalid";
}

export function vaultNameError(raw: string): TranslationKey | null {
  const problem = vaultNameProblem(raw);
  return problem ? NAME_PROBLEM_KEY[problem] : null;
}

export function vaultHandle(item: { name: string; scope: VaultScope }, field?: string): string {
  const owner = item.scope === "person" ? "me." : "";
  const suffix = field ? `.${field}` : "";
  return `\${secret.${owner}${item.name}${suffix}}`;
}

export function vaultHandles(
  item: Pick<VaultItem, "name" | "scope" | "kind">,
): { field: string | null; handle: string }[] {
  if (item.kind === "login")
    return ["username", "password"].map((field) => ({ field, handle: vaultHandle(item, field) }));
  return [{ field: null, handle: vaultHandle(item) }];
}

export function vaultFieldLabel(field: string): TranslationKey | null {
  return FIELD_LABEL[field] ?? null;
}

export function itemsInScope(items: readonly VaultItem[], scope: VaultScope): VaultItem[] {
  return items.filter((item) => item.scope === scope);
}

export function itemsMatching(items: readonly VaultItem[], search: string): VaultItem[] {
  const needle = search.trim().toLowerCase();
  if (!needle) return [...items];
  return items.filter((item) =>
    [item.name, item.description, item.connector?.display_name, item.template_slug].some((text) =>
      text?.toLowerCase().includes(needle),
    ),
  );
}

export interface VaultGroup {
  kind: VaultKind;
  label: TranslationKey;
  items: VaultItem[];
}

export function groupByKind(items: readonly VaultItem[]): VaultGroup[] {
  return VAULT_KINDS.map((kind) => ({
    kind,
    label: VAULT_KIND_LABEL[kind],
    items: items
      .filter((item) => item.kind === kind)
      .sort((a, b) => a.name.localeCompare(b.name) || a.environment.localeCompare(b.environment)),
  })).filter((group) => group.items.length > 0);
}

export function isEditableKind(kind: VaultKind): kind is VaultEntryKind {
  return kind === "secret" || kind === "login";
}

const ACTION_PERMISSION: Readonly<Record<VaultAction, string>> = {
  read: "vault:read",
  write: "vault:write",
  rotate: "vault:rotate",
  delete: "vault:delete",
  reveal: "vault:reveal",
};

export function canOnItem(
  item: Pick<VaultItem, "scope" | "kind">,
  action: VaultAction,
  permissions: readonly string[],
): boolean {
  if ((action === "write" || action === "rotate") && !isEditableKind(item.kind)) return false;
  if (item.scope === "person") return true;
  return permissions.includes(ACTION_PERMISSION[action]);
}

export function canAddToWorkspace(permissions: readonly string[]): boolean {
  return permissions.includes(ACTION_PERMISSION.write);
}

export interface VaultDraft {
  kind: VaultEntryKind;
  name: string;
  scope: VaultScope;
  environment: VaultEnvironment;
  description: string;
  token: string;
  username: string;
  password: string;
}

export function emptyDraft(canWriteWorkspace: boolean): VaultDraft {
  return {
    kind: "secret",
    name: "",
    scope: canWriteWorkspace ? "workspace" : "person",
    environment: "prod",
    description: "",
    token: "",
    username: "",
    password: "",
  };
}

export function withoutValues<T extends { token: string; username: string; password: string }>(
  draft: T,
): T {
  return { ...draft, token: "", username: "", password: "" };
}

export interface ValueDraft {
  kind: VaultEntryKind;
  token: string;
  username: string;
  password: string;
}

export function valueProblem(draft: ValueDraft): TranslationKey | null {
  if (draft.kind === "secret") return draft.token === "" ? "vault.value.missingToken" : null;
  return draft.username.trim() === "" || draft.password === "" ? "vault.value.missingLogin" : null;
}

export function draftProblems(draft: VaultDraft): {
  name: TranslationKey | null;
  value: TranslationKey | null;
} {
  return { name: vaultNameError(draft.name), value: valueProblem(draft) };
}

export function createBody(draft: VaultDraft): VaultItemCreate {
  const description = draft.description.trim();
  const base = {
    kind: draft.kind,
    name: draft.name.trim(),
    scope: draft.scope,
    environment: draft.environment,
    ...(description ? { description } : {}),
  };
  return draft.kind === "secret"
    ? { ...base, token: draft.token }
    : { ...base, username: draft.username.trim(), password: draft.password };
}

export function rotateBody(draft: ValueDraft): VaultItemUpdate {
  return draft.kind === "secret"
    ? { token: draft.token }
    : { username: draft.username.trim(), password: draft.password };
}

export interface RevealState {
  visible: boolean;
  secondsLeft: number;
}

export function revealState(
  revealedAt: number | null,
  now: number,
  seconds = REVEAL_SECONDS,
): RevealState {
  if (revealedAt === null) return { visible: false, secondsLeft: 0 };
  const left = Math.ceil((revealedAt + seconds * 1000 - now) / 1000);
  if (left <= 0) return { visible: false, secondsLeft: 0 };
  return { visible: true, secondsLeft: Math.min(left, seconds) };
}

export function revealedRows(
  values: Readonly<Record<string, string>>,
): { field: string; label: TranslationKey | null; value: string }[] {
  return Object.entries(values).map(([field, value]) => ({
    field,
    label: vaultFieldLabel(field),
    value,
  }));
}

const UNREADABLE_KEY: Readonly<Record<VaultKind, TranslationKey>> = {
  secret: "vault.error.unreadable",
  login: "vault.error.unreadable",
  connector: "vault.error.unreadableConnector",
  template_client: "vault.error.unreadableTemplate",
};

const DELETE_CONSEQUENCE_KEY: Readonly<Record<VaultKind, TranslationKey>> = {
  secret: "vault.delete.consequence",
  login: "vault.delete.consequence",
  connector: "vault.delete.connectorConsequence",
  template_client: "vault.delete.templateConsequence",
};

export function hasHandle(kind: VaultKind): boolean {
  return isEditableKind(kind);
}

export function deleteConsequenceKey(kind: VaultKind): TranslationKey {
  return DELETE_CONSEQUENCE_KEY[kind];
}

export function vaultErrorKey(error: unknown, kind: VaultKind = "secret"): TranslationKey {
  const status =
    typeof error === "object" && error !== null && "status" in error ? error.status : null;
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  if (status === 403) return "vault.error.forbidden";
  if (status === 404) return "vault.error.notFound";
  if (status === 409 || code === "vault_item_exists") return "vault.error.exists";
  if (status === 422 || code === "vault_item_unreadable") return UNREADABLE_KEY[kind];
  if (status === 400) return "vault.error.invalid";
  return "vault.error.generic";
}

export function lastUsedLabel(item: Pick<VaultItem, "last_used_at">): {
  key: TranslationKey;
  at: string | null;
} {
  return item.last_used_at
    ? { key: "vault.lastUsed", at: item.last_used_at }
    : { key: "vault.neverUsed", at: null };
}

export function emptyKey(
  scope: VaultScope,
  total: number,
  canWriteWorkspace: boolean,
): TranslationKey {
  if (total === 0) return "vault.empty.body";
  if (scope === "person") return "vault.empty.person";
  return canWriteWorkspace ? "vault.empty.workspace" : "vault.empty.workspaceReadOnly";
}

export function activityTone(result: string): "ok" | "warn" | "error" | "neutral" {
  if (result === "success") return "ok";
  if (result === "denied") return "warn";
  return result === "error" ? "error" : "neutral";
}
