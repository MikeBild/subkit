import { auth } from "@modelcontextprotocol/sdk/client/auth.js";

let override: typeof auth | null = null;

export function __setSdkAuthForTests(fn: typeof auth | null): void {
  override = fn;
}

export const sdkAuth: typeof auth = (provider, options) => (override ?? auth)(provider, options);
