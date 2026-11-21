import { eq } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction, type AuditActorType } from "../audit/types.ts";
import { ConfigSchema } from "../config/schema.ts";
import type { Executor } from "../db/client.ts";
import { tenants } from "../db/schema/index.ts";
import { logger } from "../logging/index.ts";
import { configDigest } from "./document.ts";

type Entry = Record<string, unknown>;

type ProviderChangeAction =
  | typeof AuditAction.AUTH_PROVIDER_ADDED
  | typeof AuditAction.AUTH_PROVIDER_REMOVED
  | typeof AuditAction.AUTH_PROVIDER_CHANGED;

type ProductChangeAction =
  | typeof AuditAction.PRODUCT_ADDED
  | typeof AuditAction.PRODUCT_REMOVED
  | typeof AuditAction.PRODUCT_CHANGED;

type AppBoundaryChange =
  | {
      action: ProviderChangeAction;
      provider_id: string;
      protocol: string | null;
      issuer_url: string | null;
      product_id: string | null;
      tenant_slug: string | null;
      changed_fields: string[];
    }
  | {
      action: typeof AuditAction.AUTH_PROVIDER_REORDERED;
      order_before: string[];
      order_after: string[];
    }
  | { action: ProductChangeAction; product_id: string; changed_fields: string[] };

export interface AppBoundaryActor {
  tenant_id: string;
  actor_type: AuditActorType;
  actor_id: string | null;
}

const providersSchema = ConfigSchema.shape.auth.unwrap().shape.providers;

function isEntry(value: unknown): value is Entry {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rawProviders(document: Entry): unknown {
  const auth = document.auth;
  return isEntry(auth) ? auth.providers : undefined;
}

function providersOf(document: Entry): Entry[] {
  const raw = rawProviders(document);
  const parsed = providersSchema.safeParse(raw);
  const list: unknown[] = parsed.success ? parsed.data : Array.isArray(raw) ? raw : [];
  return list.filter((item): item is Entry => isEntry(item) && typeof item.id === "string");
}

function productsOf(document: Entry): Record<string, Entry> {
  const products = document.products;
  if (!isEntry(products)) return {};
  return Object.fromEntries(
    Object.entries(products).filter((entry): entry is [string, Entry] => isEntry(entry[1])),
  );
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function changedFields(before: Entry, after: Entry): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter((key) => configDigest(before[key] ?? null) !== configDigest(after[key] ?? null))
    .sort();
}

function providerChange(
  action: ProviderChangeAction,
  provider: Entry,
  changed_fields: string[],
): AppBoundaryChange {
  return {
    action,
    provider_id: String(provider.id),
    protocol: text(provider.protocol),
    issuer_url: text(provider.issuer_url),
    product_id: text(provider.product_id),
    tenant_slug: text(provider.tenant_slug),
    changed_fields,
  };
}

export function diffAppBoundary(before: Entry, after: Entry): AppBoundaryChange[] {
  const changes: AppBoundaryChange[] = [];
  const beforeProviders = providersOf(before);
  const afterProviders = providersOf(after);
  const beforeById = new Map(beforeProviders.map((provider) => [String(provider.id), provider]));
  const afterById = new Map(afterProviders.map((provider) => [String(provider.id), provider]));
  for (const provider of afterProviders) {
    const previous = beforeById.get(String(provider.id));
    if (!previous) {
      changes.push(providerChange(AuditAction.AUTH_PROVIDER_ADDED, provider, []));
      continue;
    }
    const fields = changedFields(previous, provider);
    if (fields.length > 0)
      changes.push(providerChange(AuditAction.AUTH_PROVIDER_CHANGED, provider, fields));
  }
  for (const provider of beforeProviders) {
    if (!afterById.has(String(provider.id)))
      changes.push(providerChange(AuditAction.AUTH_PROVIDER_REMOVED, provider, []));
  }
  const order_before = beforeProviders
    .map((provider) => String(provider.id))
    .filter((id) => afterById.has(id));
  const order_after = afterProviders
    .map((provider) => String(provider.id))
    .filter((id) => beforeById.has(id));
  if (order_before.join("\n") !== order_after.join("\n"))
    changes.push({ action: AuditAction.AUTH_PROVIDER_REORDERED, order_before, order_after });

  const beforeProducts = productsOf(before);
  const afterProducts = productsOf(after);
  for (const [product_id, product] of Object.entries(afterProducts).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const previous = beforeProducts[product_id];
    if (!previous) {
      changes.push({ action: AuditAction.PRODUCT_ADDED, product_id, changed_fields: [] });
      continue;
    }
    const fields = changedFields(previous, product);
    if (fields.length > 0)
      changes.push({ action: AuditAction.PRODUCT_CHANGED, product_id, changed_fields: fields });
  }
  for (const product_id of Object.keys(beforeProducts).sort()) {
    if (!afterProducts[product_id])
      changes.push({ action: AuditAction.PRODUCT_REMOVED, product_id, changed_fields: [] });
  }
  return changes;
}

async function tenantForSlug(
  db: Executor,
  slug: string,
  cache: Map<string, string | null>,
): Promise<string | null> {
  if (cache.has(slug)) return cache.get(slug) ?? null;
  // tenant-filter:exempt — a provider names its tenant by slug in product-global configuration.
  const [row] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, slug))
    .limit(1);
  cache.set(slug, row?.id ?? null);
  return row?.id ?? null;
}

async function auditAppBoundaryChanges(
  db: Executor,
  input: {
    changes: AppBoundaryChange[];
    actor: AppBoundaryActor;
    revision: number;
    previous_revision: number;
    source: string;
  },
): Promise<void> {
  const slugs = new Map<string, string | null>();
  const base = {
    revision: input.revision,
    previous_revision: input.previous_revision,
    source: input.source,
  };
  for (const change of input.changes) {
    if (change.action === AuditAction.AUTH_PROVIDER_REORDERED) {
      await auditAwait(
        {
          tenant_id: input.actor.tenant_id,
          actor_type: input.actor.actor_type,
          actor_id: input.actor.actor_id,
          action: change.action,
          resource_type: "auth_provider",
          resource_id: null,
          metadata: { ...base, order_before: change.order_before, order_after: change.order_after },
        },
        db,
      );
      continue;
    }
    if ("provider_id" in change) {
      const tenant_id =
        (change.tenant_slug ? await tenantForSlug(db, change.tenant_slug, slugs) : null) ??
        input.actor.tenant_id;
      await auditAwait(
        {
          tenant_id,
          actor_type: input.actor.actor_type,
          actor_id: input.actor.actor_id,
          action: change.action,
          resource_type: "auth_provider",
          resource_id: change.provider_id,
          metadata: {
            ...base,
            provider_id: change.provider_id,
            protocol: change.protocol,
            issuer_url: change.issuer_url,
            product_id: change.product_id,
            changed_fields: change.changed_fields,
          },
        },
        db,
      );
      continue;
    }
    await auditAwait(
      {
        tenant_id: input.actor.tenant_id,
        actor_type: input.actor.actor_type,
        actor_id: input.actor.actor_id,
        action: change.action,
        resource_type: "product",
        resource_id: change.product_id,
        metadata: { ...base, product_id: change.product_id, changed_fields: change.changed_fields },
      },
      db,
    );
  }
}

export async function recordAppBoundaryActivation(
  db: Executor,
  input: {
    before: Entry;
    after: Entry;
    actor: AppBoundaryActor;
    revision: number;
    previous_revision: number;
    source: string;
  },
): Promise<void> {
  try {
    const changes = diffAppBoundary(input.before, input.after);
    if (changes.length === 0) return;
    await auditAppBoundaryChanges(db, {
      changes,
      actor: input.actor,
      revision: input.revision,
      previous_revision: input.previous_revision,
      source: input.source,
    });
  } catch (error) {
    logger.error({
      module: "runtime_config",
      action: "app_boundary.audit_failed",
      msg: "revision activated but its sign-in and app changes could not be audited",
      revision: input.revision,
      previous_revision: input.previous_revision,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
