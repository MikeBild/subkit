// Admin-tier list slashes — each is a near-identical
// `client.listX() → render rows → panify` pattern. Extracted from
// the main `handler.ts` switch (R7-S2 review fix).
//
// R9-W1 review fix: row shapes are typed from
// `components["schemas"]["…"]` in the generated OpenAPI client,
// not via ad-hoc `Record<string, unknown>` casts. A future
// wire-shape rename now fails the build instead of rendering
// `"undefined"` in the banner.
//
// Returns:
//   - `string | null` if the command was handled
//   - `undefined` if the name doesn't belong to this group; the
//     main dispatcher should fall through to the next handler.

import type { components } from "@cli-core/engine-api/openapi.d.ts";
import { panify, type SlashHandlerContext } from "../handler.ts";

type Connector = components["schemas"]["Connector"];
type Workflow = components["schemas"]["Workflow"];
type Execution = components["schemas"]["Execution"];
type PatchCandidate = components["schemas"]["PatchCandidate"];
type ApiKey = components["schemas"]["ApiKey"];
type SystemAccount = components["schemas"]["SystemAccount"];

// Some `client.listX()` methods still return `Record<string, unknown>[]`
// (the engine-client typing pre-dates the openapi regeneration).
// The narrow casts below pin the consumer to the OpenAPI schema so
// a wire rename fails the build at the cast site, not silently in
// `String(row.x ?? "")`. Future PR: tighten engine-client return
// types directly and drop these casts.
function asConnectors(items: readonly unknown[]): readonly Connector[] {
  return items as readonly Connector[];
}
function asWorkflows(items: readonly unknown[]): readonly Workflow[] {
  return items as readonly Workflow[];
}
function asExecutions(items: readonly unknown[]): readonly Execution[] {
  return items as readonly Execution[];
}
function asPatchCandidates(items: readonly unknown[]): readonly PatchCandidate[] {
  return items as readonly PatchCandidate[];
}
function asApiKeys(items: readonly unknown[]): readonly ApiKey[] {
  return items as readonly ApiKey[];
}
function asSystemAccounts(items: readonly unknown[]): readonly SystemAccount[] {
  return items as readonly SystemAccount[];
}

export async function dispatchAdminListSlash(
  name: string,
  ctx: SlashHandlerContext,
): Promise<string | null | undefined> {
  switch (name) {
    case "connectors": {
      const r = await ctx.client.listConnectors({ limit: 20 });
      const items = asConnectors(r.items);
      if (items.length === 0) return "no connectors";
      const lines = items.map(
        (c) => `${c.id.slice(0, 8)}  ${c.display_name.padEnd(20)}  ${c.slug}`,
      );
      return panify(ctx, "connectors", lines, `${items.length} found`);
    }
    case "workflows": {
      const r = await ctx.client.listWorkflows({ limit: 20 });
      const items = asWorkflows(r.items);
      if (items.length === 0) return "no workflows";
      const lines = items.map((w) => `${w.id.slice(0, 8)}  ${w.name.padEnd(20)}  ${w.lifecycle}`);
      return panify(ctx, "workflows", lines, `${items.length} found`);
    }
    case "executions":
    case "runs": {
      const r = await ctx.client.listExecutions({ limit: 10 });
      const items = asExecutions(r.items);
      if (items.length === 0) return "no executions";
      const lines = items.map((e) => {
        const wfId = String(e.workflow_id ?? "").slice(0, 8);
        const startedAt = String(e.started_at ?? "");
        return `${e.id.slice(0, 8)}  wf:${wfId}  ${e.status.padEnd(12)}  ${startedAt}`;
      });
      return panify(ctx, "executions", lines, `latest ${items.length}`);
    }
    case "patch-candidates": {
      const r = await ctx.client.listPatchCandidates({ limit: 10 });
      const items = asPatchCandidates(r.items);
      if (items.length === 0) return "no pending patch candidates";
      const lines = items.map((p) => {
        const wfId = String(p.workflow_id ?? "").slice(0, 8);
        return `${p.id.slice(0, 8)}  wf:${wfId}  ${p.status}`;
      });
      return panify(ctx, "patch candidates", lines, `${items.length} pending`);
    }
    case "notifications": {
      // Notification channel/rule shapes aren't yet in the openapi
      // surface; keep the existing record-string approach until
      // engine-client tightens.
      const [channels, rules] = await Promise.all([
        ctx.client
          .listNotificationChannels()
          .catch(() => ({ items: [] as Record<string, unknown>[] })),
        ctx.client
          .listNotificationRules()
          .catch(() => ({ items: [] as Record<string, unknown>[] })),
      ]);
      const lines: string[] = [];
      lines.push(`channels (${channels.items.length}):`);
      for (const c of channels.items) {
        const ch = c as Record<string, unknown>;
        lines.push(
          `  ${String(ch.id ?? "").slice(0, 8)}  ${String(ch.name ?? "").padEnd(20)}  ${String(ch.kind ?? "")}`,
        );
      }
      lines.push("");
      lines.push(`rules (${rules.items.length}):`);
      for (const rule of rules.items) {
        const r = rule as Record<string, unknown>;
        lines.push(
          `  ${String(r.id ?? "").slice(0, 8)}  ${String(r.event_type ?? "").padEnd(24)}  → ch:${String(r.channel_id ?? "").slice(0, 8)}`,
        );
      }
      return panify(ctx, "notifications", lines);
    }
    case "tunnels": {
      // Tunnel shape not yet in openapi surface.
      const r = await ctx.client.listTunnels();
      if (r.items.length === 0) return "no tunnels";
      const lines = r.items.map((t) => {
        const tun = t as Record<string, unknown>;
        return `${String(tun.id ?? "").slice(0, 8)}  ${String(tun.name ?? "").padEnd(20)}  ${String(tun.status ?? "")}`;
      });
      return panify(ctx, "tunnels", lines, `${r.items.length} found`);
    }
    case "discovery": {
      // Discovery-run shape not yet in openapi surface.
      const r = await ctx.client.listDiscoveryRuns({ limit: 10 });
      if (r.items.length === 0) return "no discovery runs";
      const lines = r.items.map((d) => {
        const dr = d as Record<string, unknown>;
        return `${String(dr.id ?? "").slice(0, 8)}  ${String(dr.label ?? "").padEnd(20)}  ${String(dr.status ?? "")}`;
      });
      return panify(ctx, "discovery runs", lines, `${r.items.length} found`);
    }
    case "apikeys": {
      const r = await ctx.client.listApiKeys();
      const items = asApiKeys(r.items);
      if (items.length === 0) return "no API keys";
      const lines = items.map((k) => {
        const name = String((k as { name?: unknown }).name ?? "");
        return `${k.id.slice(0, 8)}  ${name.padEnd(20)}  ${k.prefix}`;
      });
      return panify(ctx, "API keys", lines, `${items.length} keys`);
    }
    case "users": {
      // listIdentityUsers returns Record<string, unknown>[] today;
      // its openapi schema is Identity-specific and not directly
      // referenced from the CLI surface — keep the record cast
      // with a typed-looking field set.
      const r = await ctx.client.listIdentityUsers({ limit: 20 });
      if (r.items.length === 0) return "no users";
      const lines = r.items.map((u) => {
        const user = u as { id?: string; email?: string; kind?: string };
        return `${String(user.id ?? "").slice(0, 8)}  ${String(user.email ?? "").padEnd(30)}  ${String(user.kind ?? "")}`;
      });
      return panify(ctx, "users", lines, `${r.items.length} found`);
    }
    case "system-accounts": {
      const r = await ctx.client.listSystemAccounts();
      const items = asSystemAccounts(r.items);
      if (items.length === 0) return "no system accounts";
      const lines = items.map((sa) => `${sa.id.slice(0, 8)}  ${sa.name}`);
      return panify(ctx, "system accounts", lines, `${items.length} found`);
    }
    default:
      return undefined;
  }
}
