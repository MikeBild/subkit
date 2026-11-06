import { expect, test } from "bun:test";
import type { Executor } from "../../db/client.ts";
import { createBudgetState } from "../../docs-ingestion/budgets.ts";
import { ingestPostgresInformationSchema } from "../../docs-ingestion/sources/postgres.ts";
import { postgresIntrospectStrategy } from "../discovery/postgres-introspect.ts";
import { _withEgressTenantOriginForTests } from "../egress-guard.ts";
import type { ConnectorView } from "../types.ts";
import { assertPostgresConnectorEgress, postgresConnectorTarget } from "./postgres.ts";

const originOverrideExec = {} as Executor;

function connector(dsn: string): ConnectorView {
  return { id: "fixture", tenant_id: "fixture", dsn } as ConnectorView;
}

test("uses pg connection-string host overrides instead of only the URL authority", async () => {
  const target = connector("postgresql://user@93.184.216.34/db?host=127.0.0.1");
  expect(postgresConnectorTarget(target).hostname).toBe("127.0.0.1");
  await expect(assertPostgresConnectorEgress(target, { mode: "strict" })).rejects.toThrow();
});

test("hosted discovery and ingestion reject private DSNs before opening their independent pools", async () => {
  await _withEgressTenantOriginForTests(
    async () => "self_service",
    async () => {
      await expect(
        postgresIntrospectStrategy.fetch("postgresql://user@127.0.0.1/db", {
          tenant_id: "hosted-fixture",
          exec: originOverrideExec,
        }),
      ).rejects.toThrow("private_ip_blocked");
      await expect(
        ingestPostgresInformationSchema(
          {
            tenant_id: "hosted-fixture",
            exec: originOverrideExec,
            dsn: "postgresql://user@127.0.0.1/db",
          },
          createBudgetState(),
        ),
      ).rejects.toThrow("private_ip_blocked");
    },
  );
});

test("strict PostgreSQL guard blocks Unix socket paths before acquiring a connection", async () => {
  await expect(
    assertPostgresConnectorEgress(connector("postgresql:///db?host=/var/run/postgresql"), {
      mode: "strict",
    }),
  ).rejects.toThrow();
});

test("explicit permissive mode preserves private PostgreSQL targets", async () => {
  await expect(
    assertPostgresConnectorEgress(connector("postgresql://user@127.0.0.1/db"), {
      mode: "permissive",
    }),
  ).resolves.toBeUndefined();
});
