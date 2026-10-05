import type { Hono, MiddlewareHandler } from "hono";
import { errorFields, logger } from "../../logging/logger.ts";
import { emitResourceChange, type ResourceChangeType } from "../../pubsub/index.ts";
import type { AppEnv } from "../openapi.ts";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface ChangeAnnouncement {
  type: ResourceChangeType;
  prefixes: readonly string[];
  reads?: readonly string[];
}

export const CHANGE_ANNOUNCEMENTS: readonly ChangeAnnouncement[] = [
  { type: "file.changed", prefixes: ["/v1/files"] },
  {
    type: "identity.changed",
    prefixes: ["/v1/identity/users", "/v1/identity/invites", "/v1/identity/system-accounts"],
  },
  {
    type: "rbac.changed",
    prefixes: ["/v1/rbac", "/v1/auth/request-hooks"],
    reads: ["/v1/rbac/can"],
  },
  { type: "api_key.changed", prefixes: ["/v1/identity/api-keys"] },
  { type: "settings.changed", prefixes: ["/v1/settings", "/v1/secrets"] },
];

export function announcesChange(
  announcement: ChangeAnnouncement,
  method: string,
  path: string,
  status: number,
): boolean {
  if (!MUTATING.has(method) || status >= 400) return false;
  return !(announcement.reads ?? []).includes(path);
}

export function announceChange(announcement: ChangeAnnouncement): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    if (c.error || !announcesChange(announcement, c.req.method, c.req.path, c.res.status)) return;
    const principal = c.get("principal");
    if (!principal) return;
    try {
      await emitResourceChange(c.get("db"), {
        tenant_id: principal.tenant_id,
        type: announcement.type,
        ids: {},
      });
    } catch (err) {
      logger.warn({
        module: "http",
        action: "resource_change.announce_failed",
        msg: "list change not announced; cockpit falls back to its next refetch",
        tenant_id: principal.tenant_id,
        event_type: announcement.type,
        ...errorFields(err),
      });
    }
  };
}

export function registerChangeAnnouncements(app: Hono<AppEnv>): void {
  for (const announcement of CHANGE_ANNOUNCEMENTS) {
    const middleware = announceChange(announcement);
    for (const prefix of announcement.prefixes) app.use(`${prefix}/*`, middleware);
  }
}
