// Outbound-connection Zod schemas shared by more than one route family.
//
// `/v1/connections` lists a Kontoverbindung with its state; the connector
// routes (`GET /v1/connectors/{id}` and `…/credential`) name the connection a
// credential sends with that same state. One shape, so an expired grant reads
// the same on both pages. Mirrors `credentials/connections/types.ts`.

import { z } from "@hono/zod-openapi";

export const ConnectionStateEnum = z
  .enum(["valid", "expiring", "expired", "unreadable"])
  .openapi("ConnectionState");

/** Why a connection is not usable; set exactly when the state is expired or unreadable. */
export const ConnectionStateReasonEnum = z
  .enum(["refresh_failed", "expired_no_refresh", "secret_unreadable"])
  .openapi("ConnectionStateReason");

/** The connection as a connector's credential names it — see `summarizeConnections`. */
export const ConnectionSummarySchema = z
  .object({ id: z.string(), name: z.string(), state: ConnectionStateEnum })
  .openapi("ConnectionSummary");
