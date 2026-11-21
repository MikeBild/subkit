import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

const RESOURCE_NOT_FOUND = -32002 as ErrorCode;

export function invalidParams(message: string): McpError {
  return new McpError(ErrorCode.InvalidParams, message);
}

export function resourceNotFound(message: string): McpError {
  return new McpError(RESOURCE_NOT_FOUND, message);
}

export function urlElicitationRequired(message: string): McpError {
  return new McpError(ErrorCode.UrlElicitationRequired, message);
}

export function isRequestTimeout(error: unknown): boolean {
  return error instanceof McpError && error.code === ErrorCode.RequestTimeout;
}
