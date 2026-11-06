import type { components } from "@cli-core/engine-api/openapi";
import { appUserProvider } from "@/lib/app-user";
import type { TranslationKey } from "@/lib/i18n";
import type { SettingsPatch, SettingsResponse } from "@/pages/settings-model";

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

export type AppSummary = components["schemas"]["AppSummary"];
export type AppView = components["schemas"]["AppView"];
export type AppCheck = components["schemas"]["AppCheck"];
export type AppCheckKey = components["schemas"]["AppCheckKey"];
export type AppSignIn = components["schemas"]["AppSignIn"];

type SettingsEntry = Record<string, unknown>;

export const PRODUCTS_PATH = "products";
export const PROVIDERS_PATH = "auth.providers";
export type AppSettingsPath = typeof PRODUCTS_PATH | typeof PROVIDERS_PATH;

const PRODUCT_ID = /^[a-z][a-z0-9-]{0,62}$/;
const CLAIM_PATH = /^[A-Za-z0-9_:-]+(\.[A-Za-z0-9_:-]+)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CLAIMS = 16;

export const SIGN_IN_ALGORITHMS = [
  "ES256",
  "ES384",
  "ES512",
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "EdDSA",
] as const;

export const EXECUTION_ENVIRONMENTS = ["dev", "prod"] as const;
export type ExecutionEnvironment = (typeof EXECUTION_ENVIRONMENTS)[number];

function isEntry(value: unknown): value is SettingsEntry {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function productsFrom(value: unknown): Record<string, SettingsEntry> {
  if (!isEntry(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, SettingsEntry] => isEntry(entry[1])),
  );
}

export function withProduct(
  value: unknown,
  id: string,
  entry: SettingsEntry | null,
): Record<string, unknown> {
  const current = isEntry(value) ? value : {};
  if (entry === null) {
    const { [id]: _removed, ...rest } = current;
    return rest;
  }
  return { ...current, [id]: entry };
}

function providersFrom(value: unknown): SettingsEntry[] {
  return Array.isArray(value) ? value.filter(isEntry) : [];
}

export function withProvider(
  value: unknown,
  replacesId: string | null,
  provider: SettingsEntry | null,
): unknown[] {
  const current = Array.isArray(value) ? value : [];
  const index =
    replacesId === null ? -1 : current.findIndex((item) => isEntry(item) && item.id === replacesId);
  if (provider === null)
    return index < 0 ? [...current] : current.filter((_, position) => position !== index);
  if (index < 0) return [...current, provider];
  return current.map((item, position) => (position === index ? provider : item));
}

export function appBearerProvider(value: unknown, appId: string): SettingsEntry | null {
  return (
    providersFrom(value).find(
      (provider) => provider.protocol === "oidc_bearer" && provider.product_id === appId,
    ) ?? null
  );
}

export type AppSettingsChanges = Partial<Record<AppSettingsPath, (value: unknown) => unknown>>;

export function appSettingsPatch(
  data: Pick<SettingsResponse, "saved_revision" | "items">,
  changes: AppSettingsChanges,
): SettingsPatch {
  if (data.saved_revision === null) throw new Error("settings have no saved revision to build on");
  const next: Record<string, unknown> = {};
  for (const [path, change] of Object.entries(changes) as [
    AppSettingsPath,
    (value: unknown) => unknown,
  ][]) {
    const item = data.items.find((candidate) => candidate.path === path);
    if (!item) throw new Error(`settings do not contain ${path}`);
    next[path] = change(item.value);
  }
  return { expected_revision: data.saved_revision, changes: next, scope: "global" };
}

export type AppActivationOutcome = "active" | "restart_required" | "failed";

export function appActivationOutcome(status: string): AppActivationOutcome {
  if (status === "active") return "active";
  if (status === "restart_required") return "restart_required";
  return "failed";
}

export function appGoneFromList(
  list: { items: readonly Pick<AppSummary, "id">[] } | undefined,
  appId: string,
): boolean {
  return list !== undefined && !list.items.some((item) => item.id === appId);
}

type AppReadiness = "ready" | "needs_attention" | "not_configured";

export function appReadiness(app: Pick<AppSummary, "configured" | "ready">): AppReadiness {
  if (!app.configured) return "not_configured";
  return app.ready ? "ready" : "needs_attention";
}

export const APP_READINESS_LABEL: Readonly<Record<AppReadiness, TranslationKey>> = {
  ready: "apps.readiness.ready",
  needs_attention: "apps.readiness.attention",
  not_configured: "apps.readiness.notConfigured",
};

const APP_CHECK_LABEL: Readonly<Record<AppCheckKey, TranslationKey>> = {
  product_configured: "apps.check.productConfigured",
  sign_in_provider: "apps.check.signInProvider",
  assistant_workflow: "apps.check.assistantWorkflow",
  execution_authority: "apps.check.executionAuthority",
  credentials: "apps.check.credentials",
  budget_guard: "apps.check.budgetGuard",
};

interface AppCheckLine {
  key: AppCheckKey;
  label: string;
  state: "ok" | "needs_attention";
  detail: string;
  next: string | null;
}

export function appCheckLines(checks: readonly AppCheck[], t: Translate): AppCheckLine[] {
  return checks.map((check) => ({
    key: check.key,
    label: t(APP_CHECK_LABEL[check.key]),
    state: check.ok ? "ok" : "needs_attention",
    detail: check.message,
    next: check.ok ? null : check.next_action,
  }));
}

export function appFailingSummary(keys: readonly AppCheckKey[], t: Translate): string {
  return keys.map((key) => t(APP_CHECK_LABEL[key])).join(", ");
}

export function personEmailText(
  user: { email: string; identities?: readonly { provider_id: string }[] },
  t: Translate,
): string {
  const provider = appUserProvider(user.email, user.identities ?? []);
  if (provider === null) return user.email;
  return provider ? t("people.appUser", { provider }) : t("people.appUserUnknown");
}

export function personNameText(
  user: {
    email: string;
    display_name: string | null;
    identities?: readonly { provider_id: string }[];
  },
  t: Translate,
): string {
  return user.display_name || personEmailText(user, t);
}

export function personApps(user: {
  identities?: readonly { product_id: string | null }[];
}): string[] {
  return [
    ...new Set(
      (user.identities ?? [])
        .map((identity) => identity.product_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ].sort();
}

export function appUserLastSeen(
  user: { identities?: readonly { product_id: string | null; last_seen_at: string }[] },
  appId: string,
): string | null {
  const seen = (user.identities ?? [])
    .filter((identity) => identity.product_id === appId)
    .map((identity) => identity.last_seen_at)
    .sort();
  return seen.at(-1) ?? null;
}

export function appUserLabel(
  user: {
    id: string;
    email: string;
    display_name: string | null;
    identities?: readonly { provider_id: string }[];
  },
  t: Translate,
): string {
  return `${personNameText(user, t)} (${user.id.slice(0, 8)})`;
}

export function eraseAppUserPath(appId: string, userId: string): string {
  return `/v1/apps/${encodeURIComponent(appId)}/users/${encodeURIComponent(userId)}`;
}

function dagRecord(dag: unknown): SettingsEntry | null {
  return isEntry(dag) ? dag : null;
}

export function definitionProductId(dag: unknown): string | null {
  const id = dagRecord(dag)?.product_id;
  return typeof id === "string" && id ? id : null;
}

export function definitionGuardBucket(dag: unknown): string | null {
  const guards = dagRecord(dag)?.execution_guards;
  const limit = isEntry(guards) ? guards.caller_daily_limit : null;
  const bucket = isEntry(limit) ? limit.bucket : null;
  return typeof bucket === "string" && bucket ? bucket : null;
}

interface VersionPage {
  items: readonly { id: string; version: number; dag?: unknown }[];
  total: number;
}

type FetchVersionPage = (limit: number, offset: number) => Promise<VersionPage>;

const SCAN_PAGE = 50;

export async function fetchCurrentVersionDag(
  fetchPage: FetchVersionPage,
  currentVersionId: string | null | undefined,
  currentVersion: number | null | undefined,
): Promise<unknown> {
  if (!currentVersionId) return null;
  const newest = await fetchPage(1, 0);
  const first = newest.items[0];
  if (!first) return null;
  if (first.id === currentVersionId) return first.dag ?? null;
  if (typeof currentVersion === "number") {
    const offset = first.version - currentVersion;
    if (offset > 0 && offset < newest.total) {
      const guess = (await fetchPage(1, offset)).items[0];
      if (guess?.id === currentVersionId) return guess.dag ?? null;
    }
  }
  for (let offset = 0; offset < newest.total; offset += SCAN_PAGE) {
    const found = (await fetchPage(SCAN_PAGE, offset)).items.find(
      (version) => version.id === currentVersionId,
    );
    if (found) return found.dag ?? null;
  }
  return null;
}

export interface ProductDraft {
  execution_environment: ExecutionEnvironment;
  assistant_workflow_id: string;
  budget_bucket: string;
}

export function productDraft(
  entry: SettingsEntry | null,
  view: Pick<AppView, "settings"> | null,
): ProductDraft {
  const environment = entry?.execution_environment ?? view?.settings?.execution_environment;
  const workflow = entry?.assistant_workflow_id ?? view?.settings?.assistant_workflow.id;
  const bucket = entry?.budget_bucket ?? view?.settings?.budget_bucket;
  return {
    execution_environment: environment === "prod" ? "prod" : "dev",
    assistant_workflow_id: typeof workflow === "string" ? workflow : "",
    budget_bucket: typeof bucket === "string" ? bucket : "",
  };
}

export function productEntry(entry: SettingsEntry | null, draft: ProductDraft): SettingsEntry {
  return {
    ...(entry ?? {}),
    execution_environment: draft.execution_environment,
    assistant_workflow_id: draft.assistant_workflow_id,
    budget_bucket: draft.budget_bucket.trim(),
  };
}

export function productErrors(appId: string, draft: ProductDraft): TranslationKey[] {
  const errors: TranslationKey[] = [];
  if (!PRODUCT_ID.test(appId)) errors.push("apps.error.appId");
  if (!UUID.test(draft.assistant_workflow_id)) errors.push("apps.error.assistant");
  const bucket = draft.budget_bucket.trim();
  if (!bucket || bucket.length > 64) errors.push("apps.error.bucket");
  return errors;
}

export type ClaimType = "string" | "boolean" | "number";

export interface ClaimDraft {
  path: string;
  type: ClaimType;
  value: string;
}

export interface SignInDraft {
  id: string;
  label: string;
  issuer_url: string;
  jwks_uri: string;
  audience: string;
  algorithms: string[];
  tenant_slug: string;
  reject_anonymous: boolean;
  required_claims: ClaimDraft[];
}

function text(entry: SettingsEntry | null, key: string, fallback = ""): string {
  const value = entry?.[key];
  return typeof value === "string" ? value : fallback;
}

function claimDraft(claim: unknown): ClaimDraft | null {
  if (!isEntry(claim) || typeof claim.path !== "string") return null;
  const equals = claim.equals;
  if (typeof equals === "boolean")
    return { path: claim.path, type: "boolean", value: String(equals) };
  if (typeof equals === "number")
    return { path: claim.path, type: "number", value: String(equals) };
  return { path: claim.path, type: "string", value: typeof equals === "string" ? equals : "" };
}

export function signInDraft(provider: SettingsEntry | null, appId: string): SignInDraft {
  const algorithms = Array.isArray(provider?.algorithms)
    ? provider.algorithms.filter((value): value is string => typeof value === "string")
    : ["ES256"];
  const claims = Array.isArray(provider?.required_claims) ? provider.required_claims : [];
  return {
    id: text(provider, "id", appId),
    label: text(provider, "label", appId),
    issuer_url: text(provider, "issuer_url"),
    jwks_uri: text(provider, "jwks_uri"),
    audience: text(provider, "audience"),
    algorithms,
    tenant_slug: text(provider, "tenant_slug", "default"),
    reject_anonymous: provider?.reject_anonymous !== false,
    required_claims: claims.flatMap((claim) => claimDraft(claim) ?? []),
  };
}

function claimValue(claim: ClaimDraft): string | boolean | number {
  if (claim.type === "boolean") return claim.value === "true";
  if (claim.type === "number") return Number(claim.value);
  return claim.value;
}

export function signInProvider(
  provider: SettingsEntry | null,
  draft: SignInDraft,
  appId: string,
): SettingsEntry {
  const { jwks_uri: _jwks, ...base } = provider ?? {};
  const jwks = draft.jwks_uri.trim();
  return {
    ...base,
    protocol: "oidc_bearer",
    id: draft.id.trim(),
    label: draft.label.trim(),
    issuer_url: draft.issuer_url.trim(),
    ...(jwks ? { jwks_uri: jwks } : {}),
    audience: draft.audience.trim(),
    algorithms: SIGN_IN_ALGORITHMS.filter((algorithm) => draft.algorithms.includes(algorithm)),
    product_id: appId,
    tenant_slug: draft.tenant_slug.trim() || "default",
    required_claims: draft.required_claims.map((claim) => ({
      path: claim.path.trim(),
      equals: claimValue(claim),
    })),
    reject_anonymous: draft.reject_anonymous,
  };
}

function secureUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || ["127.0.0.1", "localhost"].includes(url.hostname);
  } catch {
    return false;
  }
}

export function signInErrors(
  appId: string,
  draft: SignInDraft,
  providers: unknown,
  replacesId: string | null,
): TranslationKey[] {
  const errors: TranslationKey[] = [];
  const others = providersFrom(providers).filter((provider) => provider.id !== replacesId);
  const id = draft.id.trim();
  if (!PRODUCT_ID.test(appId)) errors.push("apps.error.appId");
  if (!id || !draft.label.trim()) errors.push("apps.error.signInName");
  else if (others.some((provider) => provider.id === id)) errors.push("apps.error.signInIdTaken");
  const issuer = draft.issuer_url.trim();
  if (!secureUrl(issuer)) errors.push("apps.error.issuer");
  else if (
    others.some((provider) => provider.protocol === "oidc_bearer" && provider.issuer_url === issuer)
  )
    errors.push("apps.error.issuerTaken");
  if (draft.jwks_uri.trim() && !secureUrl(draft.jwks_uri.trim())) errors.push("apps.error.jwks");
  if (!draft.audience.trim()) errors.push("apps.error.audience");
  if (!draft.algorithms.some((value) => (SIGN_IN_ALGORITHMS as readonly string[]).includes(value)))
    errors.push("apps.error.algorithms");
  if (draft.required_claims.length > MAX_CLAIMS) errors.push("apps.error.claimCount");
  if (
    draft.required_claims.some(
      (claim) =>
        !CLAIM_PATH.test(claim.path.trim()) ||
        (claim.type === "number" &&
          (claim.value.trim() === "" || !Number.isFinite(Number(claim.value)))) ||
        (claim.type === "boolean" && claim.value !== "true" && claim.value !== "false"),
    )
  )
    errors.push("apps.error.claim");
  return errors;
}

export function mayEraseAppUsers(session: {
  permissions: readonly string[];
  principal: { role_name?: string | null };
}): boolean {
  return (
    session.principal.role_name === "admin" &&
    session.permissions.includes("identity:write") &&
    session.permissions.includes("settings:read")
  );
}
