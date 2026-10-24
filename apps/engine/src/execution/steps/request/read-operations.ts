import { loadBuiltinReadOperations } from "../../../connectors/templates.ts";
import type { MaterializedRequest } from "../../prepared-request.ts";

export function isDocumentedReadOperation(request: MaterializedRequest | undefined): boolean {
  if (request?.method !== "POST" || request.unsupported_body) return false;
  const operations = loadBuiltinReadOperations();
  if (operations.length === 0) return false;
  try {
    const url = new URL(request.url);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      Object.keys(request.headers).some((key) =>
        /^(?:x-http-method(?:-override)?|x-method-override)$/i.test(key),
      ) ||
      !operations.some(
        (operation) =>
          operation.method === request.method &&
          url.origin === operation.origin &&
          new RegExp(operation.path_pattern).test(url.pathname),
      )
    )
      return false;
    return (
      request.body !== null && typeof request.body === "object" && !Array.isArray(request.body)
    );
  } catch {
    return false;
  }
}
