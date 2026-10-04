import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type {
  DiscoveryServiceArgs,
  DiscoveryServiceContext,
  DiscoveryServiceResult,
} from "../../connectors/discovery/service.ts";
import type { ConnectorSelfDescriptionLink } from "../../connectors/types.ts";
import { connectors, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { SchedulerReconciler } from "../reconciler.ts";

const CADENCE_MS = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-06-01T00:00:00.000Z");
const T1 = new Date(T0.getTime() + CADENCE_MS + 1000);

let db: TestDb;
let tenantId: string;

let httpEmptyId: string;
let graphqlLinkedId: string;
let httpThrowsId: string;
let postgresId: string;
let httpNoBaseUrlId: string;
let httpDeletedId: string;

interface RecordedCall {
  connector_id: string | undefined;
  base_url: string | undefined;
  tenant_id: string;
  actor_id: string | null;
  force_refresh: boolean | undefined;
  hasSignal: boolean;
}

interface RecordedProbeCall {
  base_url: string;
  hasSignal: boolean;
}

let calls: RecordedCall[];
let probeCalls: RecordedProbeCall[];

const discoveryRunner = async (
  ctx: DiscoveryServiceContext,
  args: DiscoveryServiceArgs,
): Promise<DiscoveryServiceResult> => {
  calls.push({
    connector_id: args.connector_id,
    base_url: args.base_url,
    tenant_id: ctx.tenant_id,
    actor_id: ctx.actor_id,
    force_refresh: args.force_refresh,
    hasSignal: ctx.abortSignal instanceof AbortSignal,
  });
  if (args.connector_id === httpThrowsId) {
    throw new Error("simulated upstream failure");
  }
  return { source: "fresh", result: {}, cache_key: "test" } as unknown as DiscoveryServiceResult;
};

const noopProbeRunner = async (
  baseUrl: string,
  opts: { signal?: AbortSignal },
): Promise<ConnectorSelfDescriptionLink[]> => {
  probeCalls.push({ base_url: baseUrl, hasSignal: opts.signal instanceof AbortSignal });
  return [];
};

function makeReconciler(
  probeRunner?: (
    baseUrl: string,
    opts: { signal?: AbortSignal },
  ) => Promise<ConnectorSelfDescriptionLink[]>,
): SchedulerReconciler {
  return new SchedulerReconciler({
    boss: {} as PgBoss,
    db: db.db,
    discoveryRunner,
    probeRunner: probeRunner ?? noopProbeRunner,
  });
}

beforeAll(async () => {
  db = await createTestDb("connector-self-description");

  const [t] = await db.db
    .insert(tenants)
    .values({ slug: "t-selfdesc", display_name: "Self-Desc Tenant" })
    .returning();
  tenantId = t!.id;

  const links = {
    links: [
      {
        kind: "openapi" as const,
        url: "https://api.linked.example/openapi.json",
        source: "discovery" as const,
        discovered_at: "2026-05-01T00:00:00.000Z",
      },
    ],
  };

  const inserted = await db.db
    .insert(connectors)
    .values([
      {
        tenant_id: tenantId,
        slug: "http-empty",
        display_name: "HTTP Empty",
        driver: "http",
        base_url: "https://api.empty.example",
      },
      {
        tenant_id: tenantId,
        slug: "graphql-linked",
        display_name: "GraphQL Linked",
        driver: "graphql",
        base_url: "https://api.linked.example/graphql",
        self_description: links,
      },
      {
        tenant_id: tenantId,
        slug: "http-throws",
        display_name: "HTTP Throws",
        driver: "http",
        base_url: "https://api.throws.example",
      },
      {
        tenant_id: tenantId,
        slug: "pg-conn",
        display_name: "Postgres Conn",
        driver: "postgres",
        base_url: "https://api.pg.example",
      },
      {
        tenant_id: tenantId,
        slug: "http-no-base",
        display_name: "HTTP No Base",
        driver: "http",
        base_url: null,
      },
      {
        tenant_id: tenantId,
        slug: "http-deleted",
        display_name: "HTTP Deleted",
        driver: "http",
        base_url: "https://api.deleted.example",
        deleted_at: new Date("2026-05-15T00:00:00.000Z"),
      },
    ])
    .returning({ id: connectors.id, slug: connectors.slug });

  const bySlug = new Map(inserted.map((r) => [r.slug, r.id]));
  httpEmptyId = bySlug.get("http-empty")!;
  graphqlLinkedId = bySlug.get("graphql-linked")!;
  httpThrowsId = bySlug.get("http-throws")!;
  postgresId = bySlug.get("pg-conn")!;
  httpNoBaseUrlId = bySlug.get("http-no-base")!;
  httpDeletedId = bySlug.get("http-deleted")!;
});

beforeEach(() => {
  calls = [];
  probeCalls = [];
});

afterAll(async () => {
  await db.cleanup();
});

describe("scheduler/connector-self-description", () => {
  test("first call defers off the boot path (seeds watermark, no discovery)", async () => {
    const reconciler = makeReconciler();
    await reconciler.reconcileConnectorSelfDescription(T0);
    expect(calls).toHaveLength(0);
  });

  test("throttles below the cadence", async () => {
    const reconciler = makeReconciler();
    await reconciler.reconcileConnectorSelfDescription(T0);
    await reconciler.reconcileConnectorSelfDescription(new Date(T0.getTime() + 60 * 60 * 1000));
    expect(calls).toHaveLength(0);
  });

  test("selects only http/graphql connectors with a base_url, force_refresh + bounded signal, non-fatal", async () => {
    const reconciler = makeReconciler();
    await reconciler.reconcileConnectorSelfDescription(T0);
    await reconciler.reconcileConnectorSelfDescription(T1);

    const refreshedIds = calls.map((c) => c.connector_id).sort();
    expect(refreshedIds).toEqual([httpEmptyId, graphqlLinkedId, httpThrowsId].sort());

    expect(refreshedIds).not.toContain(postgresId);
    expect(refreshedIds).not.toContain(httpNoBaseUrlId);
    expect(refreshedIds).not.toContain(httpDeletedId);

    for (const c of calls) {
      expect(c.force_refresh).toBe(true);
      expect(c.hasSignal).toBe(true);
      expect(c.actor_id).toBeNull();
      expect(c.tenant_id).toBe(tenantId);
      expect(typeof c.base_url).toBe("string");
    }

    expect(calls).toHaveLength(3);
  });

  test("prioritises connectors needing enrichment (empty links sort first)", async () => {
    const reconciler = makeReconciler();
    await reconciler.reconcileConnectorSelfDescription(T0);
    await reconciler.reconcileConnectorSelfDescription(T1);

    const emptyIdx = calls.findIndex((c) => c.connector_id === httpEmptyId);
    const linkedIdx = calls.findIndex((c) => c.connector_id === graphqlLinkedId);
    expect(emptyIdx).toBeGreaterThanOrEqual(0);
    expect(linkedIdx).toBeGreaterThanOrEqual(0);
    expect(emptyIdx).toBeLessThan(linkedIdx);
  });

  test("probe runner is called for each selected connector", async () => {
    const reconciler = makeReconciler();
    await reconciler.reconcileConnectorSelfDescription(T0);
    await reconciler.reconcileConnectorSelfDescription(T1);

    const probedUrls = probeCalls.map((c) => c.base_url).sort();
    expect(probedUrls).toHaveLength(calls.length);

    for (const c of probeCalls) {
      expect(c.hasSignal).toBe(true);
    }
  });

  test("probe attaches multiple link kinds to the connector row", async () => {
    const multiProbeRunner = async (
      baseUrl: string,
      opts: { signal?: AbortSignal },
    ): Promise<ConnectorSelfDescriptionLink[]> => {
      probeCalls.push({ base_url: baseUrl, hasSignal: opts.signal instanceof AbortSignal });
      if (baseUrl === "https://api.empty.example") {
        return [
          {
            kind: "openapi",
            url: "https://api.empty.example/openapi.json",
            source: "self_healing",
            discovered_at: "2026-06-01T00:00:00.000Z",
          },
          {
            kind: "llms_full",
            url: "https://api.empty.example/llms-full.txt",
            source: "self_healing",
            discovered_at: "2026-06-01T00:00:00.000Z",
          },
        ];
      }
      return [];
    };

    const reconciler = makeReconciler(multiProbeRunner);
    await reconciler.reconcileConnectorSelfDescription(T0);
    await reconciler.reconcileConnectorSelfDescription(T1);

    const result = await db.db
      .select({ self_description: connectors.self_description })
      .from(connectors)
      .where(eq(connectors.id, httpEmptyId));

    const selfDesc = result[0]?.self_description as { links?: ConnectorSelfDescriptionLink[] };
    const kinds = (selfDesc?.links ?? []).map((l: ConnectorSelfDescriptionLink) => l.kind).sort();
    expect(kinds).toContain("openapi");
    expect(kinds).toContain("llms_full");
    expect(kinds.length).toBeGreaterThanOrEqual(2);
  });

  test("probe failure is non-fatal — other connectors still get probed", async () => {
    const probeThrowsRunner = async (
      baseUrl: string,
      opts: { signal?: AbortSignal },
    ): Promise<ConnectorSelfDescriptionLink[]> => {
      probeCalls.push({ base_url: baseUrl, hasSignal: opts.signal instanceof AbortSignal });
      if (baseUrl === "https://api.throws.example") {
        throw new Error("simulated probe network failure");
      }
      return [];
    };

    const reconciler = makeReconciler(probeThrowsRunner);
    await reconciler.reconcileConnectorSelfDescription(T0);
    await reconciler.reconcileConnectorSelfDescription(T1);

    expect(probeCalls.length).toBe(calls.length);
    expect(probeCalls.some((c) => c.base_url === "https://api.throws.example")).toBe(true);
  });
});
