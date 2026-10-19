import type { Context } from "hono";
import { streamSSE as honoStreamSSE } from "hono/streaming";
import { beginTenantWork } from "../execution/tenant-work.ts";
import type { AppEnv } from "./openapi.ts";

type StreamCallback = Parameters<typeof honoStreamSSE>[1];
export function streamTenantSSE(c: Context<AppEnv>, callback: StreamCallback): Response {
  const principal = c.get("principal");
  const release = principal ? beginTenantWork(principal.tenant_id) : () => {};
  try {
    return honoStreamSSE(c, async (stream) => {
      try {
        await callback(stream);
      } finally {
        release();
      }
    });
  } catch (error) {
    release();
    throw error;
  }
}
