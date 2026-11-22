import { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/types.ts";
import { browserSessionForPrincipal } from "../../auth/browser-session.ts";
import {
  isWorkspaceOwnerSession,
  updateOwnProfile,
  updateWorkspaceSettings,
} from "../../identity/workspace-settings.ts";
import { principalHolds } from "../../rbac/evaluator.ts";
import { isIanaTimeZone } from "../../workflows/types.ts";
import {
  type UpdateWorkspaceBody,
  UpdateWorkspaceBodySchema,
  WorkspaceSchema,
} from "../workspace-schemas.ts";
import { defineOperation, reject } from "./index.ts";

const TAGS = ["identity"] as const;
const BROWSER_SESSION = [{ browserSession: [] }] as const;
const UNAUTHORIZED = "Unauthorized";

const OwnProfileBody = z
  .object({
    display_name: z.string().trim().min(1).max(120).optional(),
    start_steps_hidden: z.boolean().optional(),
  })
  .strict()
  .openapi("UpdateOwnProfileBody");

const OwnProfileSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string(),
    display_name: z.string().nullable(),
    start_steps_hidden: z.boolean(),
  })
  .openapi("OwnProfile");

type OwnProfileInput = z.infer<typeof OwnProfileBody>;
type OwnProfileRow = NonNullable<Awaited<ReturnType<typeof updateOwnProfile>>>;

export const updateOwnProfileOperation = defineOperation<OwnProfileInput, OwnProfileRow>({
  id: "identity.me.update",
  summary: "Update the signed-in person's own profile in the current workspace",
  permission: null,
  effect: "write",
  audit: AuditAction.USER_PROFILE_UPDATED,
  async handler(scope, body) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const session = scope.request
      ? await browserSessionForPrincipal(scope.request, principal)
      : null;
    if (!session)
      return reject.status(403, "browser_session_required", "Sign in to the Cockpit first.");
    const row = await updateOwnProfile(
      {
        tenant_id: scope.tenant_id,
        user_id: principal.id,
        ...(body.display_name !== undefined ? { display_name: body.display_name } : {}),
        ...(body.start_steps_hidden !== undefined
          ? { start_steps_hidden: body.start_steps_hidden }
          : {}),
      },
      scope.db,
    );
    if (!row) return reject.notFound("user");
    return row;
  },
  http: {
    method: "patch",
    path: "/v1/identity/me",
    tags: TAGS,
    security: BROWSER_SESSION,
    body: OwnProfileBody,
    response: OwnProfileSchema,
    errors: {
      401: UNAUTHORIZED,
      403: "browser_session_required — only a signed-in Cockpit session edits its own profile",
      404: "Not found",
    },
    toInput: ({ json }) => json as OwnProfileInput,
    toBody: (row) => ({
      id: row.id,
      email: row.email,
      display_name: row.display_name,
      start_steps_hidden: row.start_steps_hidden_at !== null,
    }),
  },
});

type WorkspaceInput = UpdateWorkspaceBody;
type WorkspaceRow = NonNullable<Awaited<ReturnType<typeof updateWorkspaceSettings>>>;

export const updateWorkspaceOperation = defineOperation<WorkspaceInput, WorkspaceRow>({
  id: "identity.workspace.update",
  summary: "Rename the current workspace or change its time zone or language",
  permission: null,
  effect: "write",
  audit: AuditAction.TENANT_UPDATED,
  async handler(scope, body) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    if (!(await principalHolds(scope.db, principal, "identity:write"))) {
      const session = scope.request
        ? await browserSessionForPrincipal(scope.request, principal)
        : null;
      if (!session || !(await isWorkspaceOwnerSession(session, scope.db)))
        return reject.status(
          403,
          "workspace_admin_required",
          "Only the workspace owner or an administrator can change workspace settings.",
        );
    }
    if (body.timezone !== undefined && !isIanaTimeZone(body.timezone))
      return reject.unprocessable(
        "The time zone is not a known IANA time zone, for example Europe/Berlin.",
        undefined,
        "invalid_timezone",
      );
    const row = await updateWorkspaceSettings(
      {
        tenant_id: scope.tenant_id,
        ...(body.display_name !== undefined ? { display_name: body.display_name } : {}),
        ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
        ...(body.language !== undefined ? { language: body.language } : {}),
        actor_type: principal.kind,
        actor_id: principal.id,
      },
      scope.db,
    );
    if (!row) return reject.notFound("workspace");
    return row;
  },
  http: {
    method: "patch",
    path: "/v1/identity/workspace",
    tags: TAGS,
    body: UpdateWorkspaceBodySchema,
    response: WorkspaceSchema,
    errors: {
      401: UNAUTHORIZED,
      403: "workspace_admin_required — neither the workspace owner nor a holder of identity:write",
      404: "Not found",
      422: "invalid_timezone — not an IANA time zone",
    },
    toInput: ({ json }) => json as WorkspaceInput,
    toBody: (row) => ({
      id: row.id,
      display_name: row.display_name,
      timezone: row.timezone,
      language: row.language,
      origin: row.origin,
    }),
  },
});
