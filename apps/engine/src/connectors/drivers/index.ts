// Driver registry. `probeConnector` dispatches a health probe to the
// correct driver given a connector row. New drivers register here.

import type { Db } from "../../db/client.ts";
import type { ConnectorView } from "../types.ts";
import { probeFtpConnector } from "./ftp.ts";
import { probeGraphQLConnector } from "./graphql.ts";
import { probeHttpConnector } from "./http.ts";
import { probeMssqlConnector } from "./mssql.ts";
import { probePgConnector } from "./postgres.ts";
import { probeRedisConnector } from "./redis.ts";
import { probeS3Connector } from "./s3.ts";
import { probeSftpConnector } from "./sftp.ts";
import { probeSmbConnector } from "./smb.ts";

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
    case "mssql":
      return probeMssqlConnector(p.connector);
    case "redis":
      return probeRedisConnector(p.connector);
    case "ftp":
      return probeFtpConnector(p.connector);
    case "sftp":
      return probeSftpConnector(p.connector);
    case "smb":
      return probeSmbConnector(p.connector);
    default: {
      return {
        ok: false,
        latency_ms: 0,
        detail: `unknown driver: ${p.connector.driver}`,
      };
    }
  }
}

export {
  probeFtpConnector,
  probeGraphQLConnector,
  probeHttpConnector,
  probeMssqlConnector,
  probePgConnector,
  probeRedisConnector,
  probeS3Connector,
  probeSftpConnector,
  probeSmbConnector,
};
