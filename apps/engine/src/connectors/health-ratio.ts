import { and, eq, isNull, ne, or, type SQL } from "drizzle-orm";
import { connectors } from "../db/schema/index.ts";

export function connectorCountsTowardHealth(): SQL {
  return and(eq(connectors.enabled, true), isNull(connectors.deleted_at)) as SQL;
}

export function connectorCountsAgainstHealth(): SQL {
  return and(
    connectorCountsTowardHealth(),
    or(eq(connectors.needs_reauth, true), ne(connectors.health_state, "ok")),
  ) as SQL;
}

export function connectorNeedsReauth(): SQL {
  return and(connectorCountsTowardHealth(), eq(connectors.needs_reauth, true)) as SQL;
}
