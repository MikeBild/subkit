import { and, eq, isNull, ne, type SQL } from "drizzle-orm";
import { connectors } from "../db/schema/index.ts";

export function connectorCountsTowardHealth(): SQL {
  return and(eq(connectors.enabled, true), isNull(connectors.deleted_at)) as SQL;
}

export function connectorCountsAgainstHealth(): SQL {
  return and(connectorCountsTowardHealth(), ne(connectors.health_state, "ok")) as SQL;
}
