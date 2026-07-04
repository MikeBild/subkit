// Shared error renderer for MCP tool and capability handlers.
//
// MCP wraps every failure as `{ isError: true, content: [{ type: "text",
// text }] }`. The SDK shape is fixed, but the text must carry the same
// `code`/`message` that the REST surface emits so operators can match
// MCP errors to HTTP logs.

import { HttpError } from "../http/errors.ts";

/**
 * Render an unknown error into the text payload of an MCP error frame.
 * Mirrors `formatError()` in the CLI so all three surfaces print
 * `${code}: ${message}` for the same underlying failure.
 */
export function toMcpErrorText(err: unknown): string {
  if (err instanceof HttpError) {
    return `${err.code}: ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
