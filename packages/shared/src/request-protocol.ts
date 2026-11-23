export const REQUEST_PROTOCOLS = ["http", "graphql", "sql", "s3", "mcp"] as const;

export type RequestProtocol = (typeof REQUEST_PROTOCOLS)[number];

export type RequestProtocolDriver = "http" | "graphql" | "postgres" | "s3" | "mcp";

const DRIVER_OF: Record<RequestProtocol, RequestProtocolDriver> = {
  http: "http",
  graphql: "graphql",
  sql: "postgres",
  s3: "s3",
  mcp: "mcp",
};

export function requestProtocol(step: { protocol?: RequestProtocol | undefined }): RequestProtocol {
  return step.protocol ?? "http";
}

export function requestProtocolDriver(step: {
  protocol?: RequestProtocol | undefined;
}): RequestProtocolDriver {
  return DRIVER_OF[requestProtocol(step)];
}
