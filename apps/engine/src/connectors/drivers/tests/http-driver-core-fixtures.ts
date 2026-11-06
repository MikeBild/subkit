import type { TestDb } from "../../../db/tests/setup.ts";
import type { MockServer } from "../../../test-helpers/mock-http.ts";
import { createConnector, getConnector } from "../../service.ts";
import type { ConnectorView } from "../../types.ts";

export function httpDriverCoreFixtures(state: {
  readonly tenantId: string;
  readonly mock: MockServer;
  readonly ctx: TestDb;
}) {
  async function makeConnector(params: {
    auth_type: ConnectorView["auth_type"];
    config?: Record<string, unknown>;
    base_url?: string;
    template_slug?: string;
  }): Promise<ConnectorView> {
    const created = await createConnector(
      {
        tenant_id: state.tenantId,
        input: {
          name: `http-core-${Math.random().toString(36).slice(2, 8)}`, // allow-random: unique slug per test
          driver: "http",
          environment: "dev",
          base_url: params.base_url ?? state.mock.baseUrl,
          auth_type: params.auth_type,
          config: params.config ?? {},
          ...(params.template_slug ? { template_slug: params.template_slug } : {}),
        },
        actor_id: null,
      },
      state.ctx.db,
    );
    const fresh = await getConnector(state.tenantId, created.id, state.ctx.db);
    if (!fresh) throw new Error("connector round-trip failed");
    return fresh;
  }

  return { makeConnector };
}
