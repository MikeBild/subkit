import type { ConnectorView } from "../../connectors/types.ts";
import type { ResolvedAuthorityReference } from "../../llm/substitution/resolver.ts";
import {
  assertDirectConnectorBinding,
  DirectConnectorBindingError,
  type LoadedConnectorCredential,
} from "../../tools/direct-connector-binding.ts";
import type { ToolContext } from "./index.ts";

export async function preflightDirectConnector(ctx: ToolContext, connector: ConnectorView) {
  const approval = ctx.direct_connector_approval;
  if (!approval) return;
  const target = approval.binding?.target;
  await directConnectorGuard(
    ctx,
    connector,
  )?.({
    credential_id: target?.credential_id ?? null,
    credential_revision: target?.credential_revision ?? null,
    connection_authority: target?.connection_authority ?? null,
  });
}

export function directConnectorGuard(
  ctx: ToolContext,
  connector: ConnectorView,
  references: readonly ResolvedAuthorityReference[] = [],
) {
  const approval = ctx.direct_connector_approval;
  if (!approval) return undefined;
  return async (credential: LoadedConnectorCredential) => {
    if (!ctx.principal) throw new DirectConnectorBindingError();
    return assertDirectConnectorBinding({
      db: ctx.db,
      tenant_id: ctx.tenant_id,
      principal: ctx.principal,
      approval,
      connector,
      credential,
      references,
    });
  };
}
