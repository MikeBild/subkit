// Vendor recipe gate scanner.
//
// Catches the most common failure mode of MCP-onboarding turns: the
// assistant emits a fenced ```json block containing an `mcpServers`
// entry whose `url` does not match the runtime `engine_url`. The
// rule is structural — we don't validate against a specific recipe
// template here (that would require client identification mid-text);
// instead we assert that any `mcpServers.*.url` field that points at
// a subkit-shaped origin must equal `engine_url`. Foreign hosts
// (the user already runs another MCP server) are ignored.
//
// Authorization headers containing `<placeholder>`-like patterns
// are flagged separately so the user does not paste the block
// before swapping the key in.

import type { Scanner, ScannerContext, Violation } from "../types.ts";

const SUBKIT_HOST_RE = /\b(?:[a-z0-9-]+\.)*subkit(?:[a-z0-9-]+)?(?:-[a-z0-9-]+)?\.(?:[a-z]+)\b/i;
const FENCED_JSON_RE = /```(?:json|jsonc)?\s*\n([\s\S]*?)```/g;
const PLACEHOLDER_BEARER_RE = /Bearer\s+(?:<[A-Z_]+>|\$\{[A-Za-z_]+\}|YOUR[_-][A-Z]+|\[[a-z-]+\])/;

interface McpServerEntry {
  url?: unknown;
  command?: unknown;
  args?: unknown;
  headers?: { Authorization?: unknown } & Record<string, unknown>;
  transport?: unknown;
}

function looksLikeSubkitOrigin(url: URL, engineUrl?: URL): boolean {
  if (engineUrl && url.host === engineUrl.host) return true;
  if (SUBKIT_HOST_RE.test(url.host)) return true;
  if (engineUrl && /^(localhost|127\.|::1)/i.test(url.host)) return true;
  return false;
}

function checkServer(name: string, server: McpServerEntry, ctx: ScannerContext): Violation[] {
  const out: Violation[] = [];
  let engineUrl: URL | undefined;
  if (ctx.engine_url) {
    try {
      engineUrl = new URL(ctx.engine_url);
    } catch {
      /* ignore malformed engine_url — handled elsewhere */
    }
  }
  if (typeof server.url === "string") {
    let parsed: URL;
    try {
      parsed = new URL(server.url);
    } catch {
      return out;
    }
    if (looksLikeSubkitOrigin(parsed, engineUrl) && engineUrl && parsed.origin !== engineUrl.origin) {
      out.push({
        kind: "vendor_recipe.host_mismatch",
        message: `MCP recipe for server "${name}" points at ${parsed.origin}, not the runtime engine_url ${engineUrl.origin}.`,
        details: {
          server: name,
          emitted_origin: parsed.origin,
          engine_url_origin: engineUrl.origin,
        },
      });
    }
    if (looksLikeSubkitOrigin(parsed) && parsed.pathname !== "/mcp" && parsed.pathname !== "/mcp/") {
      out.push({
        kind: "vendor_recipe.bad_path",
        message: `MCP recipe URL for "${name}" should end in /mcp, got ${parsed.pathname}`,
        details: { server: name, path: parsed.pathname },
      });
    }
  }
  if (server.headers && typeof server.headers === "object") {
    const auth = (server.headers as { Authorization?: unknown }).Authorization;
    if (typeof auth === "string" && PLACEHOLDER_BEARER_RE.test(auth)) {
      out.push({
        kind: "vendor_recipe.placeholder_auth",
        message: `MCP recipe for server "${name}" carries a placeholder Authorization header. Mint a real key with create_api_key and inline it.`,
        details: { server: name, header: auth },
      });
    }
  }
  return out;
}

export const vendorRecipeScanner: Scanner = {
  id: "vendor_recipe",
  scan(text: string, ctx: ScannerContext): Violation[] {
    const out: Violation[] = [];
    FENCED_JSON_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop.
    while ((m = FENCED_JSON_RE.exec(text)) !== null) {
      const body = m[1] ?? "";
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        continue; // not JSON — leave to other scanners
      }
      const root = parsed as { mcpServers?: Record<string, McpServerEntry> };
      const servers = root?.mcpServers;
      if (!servers || typeof servers !== "object") continue;
      for (const [name, entry] of Object.entries(servers)) {
        if (!entry || typeof entry !== "object") continue;
        out.push(...checkServer(name, entry as McpServerEntry, ctx));
      }
    }
    return out;
  },
};
