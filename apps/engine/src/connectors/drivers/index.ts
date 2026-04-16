// Driver registry. `probeConnector` dispatches a health probe to the
// correct driver given a connector row. New drivers register here.

import type { Db } from "../../db/client.ts";
import type { ConnectorView } from "../types.ts";
import { probeGraphQLConnector } from "./graphql.ts";
import { probeHttpConnector } from "./http.ts";
import { probePgConnector } from "./postgres.ts";
import { probeS3Connector } from "./s3.ts";

export interface ProbeResult {
  ok: boolean;
  latency_ms: number;
  status?: number;
  detail?: string;
}

export async function probeConnector(p: {
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
}): Promise<ProbeResult> {
  switch (p.connector.driver) {
    case "http":
      return probeHttpConnector(p);
    case "postgres":
      return probePgConnector(p.connector);
    case "s3":
      return probeS3Connector(p);
    case "graphql":
      return probeGraphQLConnector(p);
    default: {
      return {
        ok: false,
        latency_ms: 0,
        detail: `unknown driver: ${p.connector.driver}`,
      };
    }
  }
}

export { probeGraphQLConnector, probeHttpConnector, probePgConnector, probeS3Connector };
