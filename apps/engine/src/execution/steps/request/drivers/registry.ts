import type { DriverRegistry } from "../../../../connectors/drivers/port.ts";
import type { RequestStep } from "../../../../workflows/types.ts";
import type { StepResult } from "../../../types.ts";
import type { RequestDispatch } from "./context.ts";
import { graphqlRequestDriver } from "./graphql.ts";
import { httpRequestDriver } from "./http.ts";
import {
  localBrowserRequestDriver,
  localComputerRequestDriver,
  localFilesRequestDriver,
} from "./local.ts";
import { mcpRequestDriver } from "./mcp.ts";
import { postgresRequestDriver } from "./postgres.ts";
import { s3RequestDriver } from "./s3.ts";
import { sftpRequestDriver } from "./sftp.ts";

export const DRIVERS: DriverRegistry<RequestDispatch, StepResult, RequestStep> = {
  http: httpRequestDriver,
  graphql: graphqlRequestDriver,
  mcp: mcpRequestDriver,
  s3: s3RequestDriver,
  sftp: sftpRequestDriver,
  postgres: postgresRequestDriver,
  local_files: localFilesRequestDriver,
  local_browser: localBrowserRequestDriver,
  local_computer: localComputerRequestDriver,
};
