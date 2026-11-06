import { z } from "@hono/zod-openapi";
import { getConfig } from "../../config/loader.ts";
import type { ToolContext, ToolResult } from "../../conversations/tools/index.ts";

const PACKAGE_ITEM_LIMIT = 100;

export const PackageFileIdInput = z
  .string()
  .min(1)
  .describe(
    "The package file: its fid_… id from export_tenant_package, list_attachments or the attached file's description, or @attachment:<slug> for a package attached to this chat.",
  );

type FailureExtras = Pick<Extract<ToolResult, { ok: false }>, "details" | "next_best_actions">;

export function packageToolFailure(
  error_code: string,
  message: string,
  extra: FailureExtras = {},
): ToolResult {
  return { ok: false, error_code, message, ...extra };
}

export function packageToolSource(ctx: ToolContext): "mcp" | "chat" {
  return ctx.direct_mcp_invocation === true ? "mcp" : "chat";
}

export function authenticationRequired(): ToolResult {
  return packageToolFailure("authentication_required", "An authenticated caller is required.");
}

export function invalidPackageFileId(): ToolResult {
  return packageToolFailure(
    "invalid_file_id",
    "file_id must be a package file id (fid_…) or @attachment:<slug> of a package attached to this chat.",
    { next_best_actions: ["list_attachments", "export_tenant_package"] },
  );
}

export function packageArchiveNotFound(): ToolResult {
  return packageToolFailure(
    "package_archive_not_found",
    "No ready SubKit package file with this id exists in this tenant.",
    { next_best_actions: ["export_tenant_package", "list_attachments"] },
  );
}

export function unreadablePackageArchive(code: string, detail: string): ToolResult {
  return packageToolFailure(code, `The package file cannot be read: ${detail}`);
}

export function compactPackageItems<T extends { action: string }>(items: readonly T[]) {
  const changed = items.filter((item) => item.action !== "unchanged");
  return {
    items: changed.slice(0, PACKAGE_ITEM_LIMIT),
    truncated: changed.length > PACKAGE_ITEM_LIMIT,
  };
}

export function publicBaseUrl(): string | null {
  try {
    const base = getConfig().server.public_base_url;
    if (base && base.length > 0) return base.endsWith("/") ? base.slice(0, -1) : base;
  } catch {}
  return null;
}

export function packageReviewUrl(path: string): string {
  const base = publicBaseUrl();
  return base ? `${base.replace(/\/+$/, "")}${path}` : path;
}
