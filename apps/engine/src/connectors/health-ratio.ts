// Which connectors the installation's connector-health ratio counts, and
// which of them count against it — asked once.
//
// The operational overview divides the healthy connectors by every counted
// one; its health causes list the ones that are not healthy; and
// `GET /v1/connectors?health=not_ok` is the list a red connector tile opens.
// Three readers of one question. The cockpit used to answer the third by
// reading 200 enabled connectors and filtering them itself, so past 200 the
// list was short and its total was wrong while the ratio beside it was right.
//
// The raw `health_state` column is the predicate, not `effectiveConnectorHealth`:
// the ratio has always counted the column, and a list that consulted a second
// rollup could name a connector the ratio does not count.

import { and, eq, isNull, ne, type SQL } from "drizzle-orm";
import { connectors } from "../db/schema/index.ts";

/** Counted by the ratio at all: enabled and not deleted. A disabled connector is not in it. */
export function connectorCountsTowardHealth(): SQL {
  return and(eq(connectors.enabled, true), isNull(connectors.deleted_at)) as SQL;
}

/** Pulls the ratio down: counted, and anything but `ok`. The ratio's numerator is the complement. */
export function connectorCountsAgainstHealth(): SQL {
  return and(connectorCountsTowardHealth(), ne(connectors.health_state, "ok")) as SQL;
}
