// Thin indirection over the MCP SDK's `auth()` driver (RFC 9728 PRM →
// RFC 8414 AS discovery → RFC 7591 DCR → PKCE → token exchange). Routes call
// `sdkAuth` instead of importing `auth` from the SDK directly so tests can
// substitute the driver in-process.
//
// ── TEST SEAM ────────────────────────────────────────────────────────────────
// Production never sets the override; tests inject a fake driver WITHOUT
// bun's `mock.module` (module mocks are process-global and leak into every
// other test file in the same worker). Null by default, so a missed restore
// can never alter production behavior — but tests MUST still restore null
// in afterAll.

import { auth } from "@modelcontextprotocol/sdk/client/auth.js";

let override: typeof auth | null = null;

export function __setSdkAuthForTests(fn: typeof auth | null): void {
  override = fn;
}

export const sdkAuth: typeof auth = (provider, options) => (override ?? auth)(provider, options);
