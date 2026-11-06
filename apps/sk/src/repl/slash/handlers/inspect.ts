import { panify, type SlashHandlerContext } from "../handler.ts";

export async function dispatchInspectSlash(
  name: string,
  ctx: SlashHandlerContext,
): Promise<string | null | undefined> {
  switch (name) {
    case "skills": {
      if (ctx.openPane) {
        ctx.openPane({ kind: "settings", initialTab: "Skills" });
        return null;
      }
      const r = await ctx.client.listSkills();
      if (r.items.length === 0) return "no skills in scope";
      const lines = r.items.map((s) => `${s.scope.padEnd(8)} ${s.title}`);
      return panify(ctx, "skills", lines, `${r.items.length} in scope`);
    }
    case "mcp": {
      const [prompts, resources, tools] = await Promise.all([
        ctx.client.listMcpPrompts().catch(() => ({ items: [] })),
        ctx.client.listMcpResources().catch(() => ({ items: [] })),
        ctx.client.listMcpTools().catch(() => ({ items: [] })),
      ]);
      const lines: string[] = [];
      lines.push(`prompts (${prompts.items.length}):`);
      for (const p of prompts.items) lines.push(`  /mcp__${p.name} — ${p.description ?? ""}`);
      lines.push("");
      lines.push(`resources (${resources.items.length}):`);
      for (const r of resources.items) lines.push(`  ${r.uri} · ${r.name}`);
      lines.push("");
      lines.push(`callable entries (${tools.items.length}):`);
      for (const t of tools.items) lines.push(`  ${t.name} — ${t.description}`);
      return panify(ctx, "mcp catalog", lines);
    }
    case "permissions": {
      if (ctx.openPane) {
        const tenant = ctx.statusSnapshot?.tenant.slug ?? null;
        ctx.openPane({ kind: "permissions", tenant });
        return null;
      }
      if (ctx.allowedPermissions.length === 0) return "no permissions probe cached";
      return panify(
        ctx,
        "permissions",
        ctx.allowedPermissions.map((p) => `  ${p}`),
        `${ctx.allowedPermissions.length} granted`,
      );
    }
    case "admin": {
      if (ctx.openPane) {
        const tenant = ctx.statusSnapshot?.tenant.slug ?? null;
        ctx.openPane({ kind: "admin", tenant });
        return null;
      }
      return "open `sk` with the Ink REPL to use /admin";
    }
    case "audit": {
      const res = await ctx.client.tailAuditLog({ limit: 20 });
      const rows = res.items.slice(0, 20);
      if (rows.length === 0) return "no audit rows visible to this principal";
      const lines = rows.map(
        (r) => `${r.ts}  ${r.action.padEnd(28)} ${(r.resource_id ?? "").slice(0, 8)}`,
      );
      return panify(ctx, "audit log", lines, `latest ${rows.length}`);
    }
    case "knowledge": {
      if (ctx.openPane) {
        ctx.openPane({ kind: "settings", initialTab: "Knowledge" });
        return null;
      }
      const r = await ctx.client.listKnowledgeSources({ limit: 20 });
      if (r.items.length === 0) return "no knowledge sources";
      const lines = r.items.map((k) => `${k.id.slice(0, 8)}  ${k.name}  ${k.source_type}`);
      return panify(ctx, "knowledge sources", lines, `${r.items.length} found`);
    }
    default:
      return undefined;
  }
}
