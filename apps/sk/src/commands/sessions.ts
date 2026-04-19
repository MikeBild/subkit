// sk session commands — ls / show / rename / rm.
//
// Thin wrappers over `sessions.ts`. They read the local cache at
// `~/.sk/sessions/*.json`; the engine-side conversation rows are
// unaffected. `rm` only removes the local file — on the server the
// conversation row is preserved (history remains queryable), it just
// won't appear in the user's sk cache anymore.

import { existsSync, unlinkSync } from "node:fs";
import { defineCommand } from "citty";
import pc from "picocolors";
import { resolveProfile } from "../config.ts";
import {
  listSessionMetadata,
  loadSessionMetadata,
  resolveSessionRef,
  saveSessionMetadata,
  sessionPath,
} from "../sessions.ts";

function fmtRelative(iso: string): string {
  const t = new Date(iso).getTime();
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const lsCommand = defineCommand({
  meta: { name: "ls", description: "List cached conversation sessions for the active profile" },
  args: {
    limit: { type: "string", description: "Max rows", default: "20" },
    search: { type: "string", description: "Filter by substring in title / alias" },
    all: { type: "boolean", description: "Show every profile, not just the active one" },
  },
  run({ args }) {
    const profile = resolveProfile();
    const filter = args.all
      ? undefined
      : {
          engine_url: profile.engine_url,
          tenant_id: profile.active_tenant_id ?? null,
        };
    const rows = listSessionMetadata(filter);
    const q = typeof args.search === "string" && args.search.length > 0 ? args.search.toLowerCase() : null;
    const filtered = q
      ? rows.filter((r) =>
          (r.title ?? "").toLowerCase().includes(q) ||
          (r.alias ?? "").toLowerCase().includes(q) ||
          r.conversation_id.includes(q),
        )
      : rows;
    const limit = Math.max(1, Number.parseInt(args.limit, 10) || 20);
    const shown = filtered.slice(0, limit);
    if (shown.length === 0) {
      process.stdout.write("no cached sessions\n");
      return;
    }
    // Header
    process.stdout.write(
      `${pc.bold("ID")}         ${pc.bold("ALIAS")}            ${pc.bold("TITLE")}              ${pc.bold("LAST USED")}\n`,
    );
    for (const r of shown) {
      const id = r.conversation_id.slice(0, 8);
      const alias = (r.alias ?? "-").padEnd(16);
      const title = (r.title ?? "(untitled)").slice(0, 20).padEnd(20);
      const when = fmtRelative(r.last_used_at);
      process.stdout.write(`${id}   ${alias} ${title} ${when}\n`);
    }
    if (filtered.length > shown.length) {
      process.stdout.write(`... ${filtered.length - shown.length} more (use --limit)\n`);
    }
  },
});

const showCommand = defineCommand({
  meta: { name: "show", description: "Show cached metadata for a session by id or alias" },
  args: {
    ref: { type: "positional", description: "Conversation id or alias", required: true },
  },
  run({ args }) {
    const profile = resolveProfile();
    const meta = resolveSessionRef(args.ref, {
      engine_url: profile.engine_url,
      tenant_id: profile.active_tenant_id ?? null,
    });
    if (!meta) {
      process.stderr.write(`${pc.red("not found")}: ${args.ref}\n`);
      process.exit(1);
    }
    process.stdout.write(`${pc.bold("conversation_id")}: ${meta.conversation_id}\n`);
    if (meta.alias) process.stdout.write(`${pc.bold("alias")}:           ${meta.alias}\n`);
    if (meta.title) process.stdout.write(`${pc.bold("title")}:           ${meta.title}\n`);
    process.stdout.write(`${pc.bold("engine_url")}:      ${meta.engine_url}\n`);
    if (meta.tenant_id) process.stdout.write(`${pc.bold("tenant_id")}:       ${meta.tenant_id}\n`);
    if (meta.model) process.stdout.write(`${pc.bold("model")}:           ${meta.model}\n`);
    process.stdout.write(`${pc.bold("created_at")}:      ${meta.created_at}\n`);
    process.stdout.write(`${pc.bold("last_used_at")}:    ${meta.last_used_at}  (${fmtRelative(meta.last_used_at)})\n`);
  },
});

const renameCommand = defineCommand({
  meta: {
    name: "rename",
    description: "Assign or change a short alias for a session (used by `sk -r <alias>`)",
  },
  args: {
    ref: { type: "positional", description: "Conversation id or existing alias", required: true },
    alias: { type: "positional", description: "New alias", required: true },
  },
  run({ args }) {
    const profile = resolveProfile();
    const meta = resolveSessionRef(args.ref, {
      engine_url: profile.engine_url,
      tenant_id: profile.active_tenant_id ?? null,
    });
    if (!meta) {
      process.stderr.write(`${pc.red("not found")}: ${args.ref}\n`);
      process.exit(1);
    }
    // Reject obviously-bad aliases.
    if (!/^[a-z0-9_-]{1,48}$/.test(args.alias)) {
      process.stderr.write(
        `${pc.red("invalid alias")}: must match /^[a-z0-9_-]{1,48}$/ (lowercase, digits, dash, underscore)\n`,
      );
      process.exit(1);
    }
    // Refuse a collision with an existing alias on the same profile.
    const collision = listSessionMetadata({
      engine_url: profile.engine_url,
      tenant_id: profile.active_tenant_id ?? null,
    }).find((r) => r.alias === args.alias && r.conversation_id !== meta.conversation_id);
    if (collision) {
      process.stderr.write(
        `${pc.red("alias in use")}: '${args.alias}' points at ${collision.conversation_id.slice(0, 8)}\n`,
      );
      process.exit(1);
    }
    saveSessionMetadata({ ...meta, alias: args.alias, last_used_at: meta.last_used_at });
    process.stdout.write(`${pc.green("ok")} ${meta.conversation_id.slice(0, 8)} → ${args.alias}\n`);
  },
});

const rmCommand = defineCommand({
  meta: {
    name: "rm",
    description:
      "Drop a session from the local cache (the server-side conversation row is preserved)",
  },
  args: {
    ref: { type: "positional", description: "Conversation id or alias", required: true },
  },
  run({ args }) {
    const profile = resolveProfile();
    const meta = resolveSessionRef(args.ref, {
      engine_url: profile.engine_url,
      tenant_id: profile.active_tenant_id ?? null,
    });
    if (!meta) {
      process.stderr.write(`${pc.red("not found")}: ${args.ref}\n`);
      process.exit(1);
    }
    const path = sessionPath(meta.conversation_id);
    if (existsSync(path)) unlinkSync(path);
    process.stdout.write(
      `${pc.green("ok")} removed ${meta.conversation_id.slice(0, 8)}${meta.alias ? ` (${meta.alias})` : ""} from local cache\n`,
    );
    // Reassure the user the server row is still there.
    process.stdout.write(
      `${pc.dim("the server-side conversation row is preserved; use `sk -r ")}${meta.conversation_id.slice(0, 8)}${pc.dim("` to reattach")}\n`,
    );
    void loadSessionMetadata; // tsc: keep the re-export live
  },
});

export const sessionsCommand = defineCommand({
  meta: { name: "sessions", description: "Manage locally-cached conversation sessions" },
  subCommands: {
    ls: lsCommand,
    show: showCommand,
    rename: renameCommand,
    rm: rmCommand,
  },
});

// Also export the subcommands directly so `sk ls` / `sk show` etc.
// can be mounted as top-level aliases.
export { lsCommand as skLs, rmCommand as skRm, renameCommand as skRename, showCommand as skShow };
