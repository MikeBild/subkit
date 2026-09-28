import type { components } from "@/api/schema";
import { absolute, conversationHref, identifierParam, recordHref, runHref } from "@/app/links";
import type { CatalogResource } from "@/app/route-table";
import type { TranslationKey } from "@/lib/i18n";
import { type CatalogLabel, catalogLabel } from "@/lib/machine-label";

type AuditEntry = components["schemas"]["AuditEntry"];
type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;
type FormatDateTime = (value: string | Date) => string;

/**
 * Which audited resource types the Cockpit can actually open.
 *
 * The rule for membership is narrow and it is the whole value of the map: the
 * id the log recorded must be the id a detail route takes. The engine writes
 * about sixty resource types; these are the ones whose record has an address,
 * and the rest stay plain text, because a link that lands nowhere is worse
 * than the word it replaced.
 *
 * `execution` used to be excluded, and this comment used to say why: there was
 * no run detail route. That was the costliest of the absences, because the row
 * naming a run is the row an investigation starts from, and it was the one row
 * that could not reach what it named. `/runs/$resourceId` exists now
 * (`app/route-table.ts`) and takes exactly the id the log records.
 *
 * A LIST page is deliberately not a target. `/people`, `/access`,
 * `/api-access` and the rest resolve perfectly well, and they answer "who are
 * the people here", not "which user is this row about" — and they would answer
 * it whether or not the row recorded an id at all, which is the distinction
 * this function exists to keep. Appending the id anyway would build
 * `/people/<id>`: an address no route matches.
 */
const RESOURCE_ROUTES: Record<string, CatalogResource | "chat" | "runs"> = {
  workflow: "workflows",
  connector: "connectors",
  knowledge_source: "knowledge",
  skill: "skills",
  file: "files",
  conversation: "chat",
  execution: "runs",
};

/**
 * The types that get a link, for the guard that proves each one resolves.
 *
 * Derived rather than written out a second time: a target added above is
 * checked against the router without anyone remembering to list it here.
 */
export const LINKED_RESOURCE_TYPES: readonly string[] = Object.keys(RESOURCE_ROUTES);

export function auditResourceHref(resourceType: string, resourceId: string | null): string | null {
  if (!resourceId) return null;
  const route = RESOURCE_ROUTES[resourceType];
  if (!route) return null;
  return absolute(
    route === "chat"
      ? conversationHref(resourceId)
      : route === "runs"
        ? runHref(resourceId)
        : recordHref(route, resourceId),
  );
}

const ACTOR_KEYS: Record<string, TranslationKey> = {
  user: "audit.actor.user",
  system_account: "audit.actor.systemAccount",
  system: "audit.actor.system",
};

/**
 * The kind of principal that acted, as a word. A kind this build has no word
 * for is the engine's own value, marked as one — "Unbekannt" about a value the
 * log recorded exactly would be false (§2, §15.2).
 */
export function actorTypeLabel(actorType: string, t: Translate): CatalogLabel {
  return catalogLabel(actorType, ACTOR_KEYS[actorType], t);
}

/**
 * Whether this reader may list people and system accounts.
 *
 * The directory routes pass `identity:read` and then insist on the ROLE
 * `admin` (`policy.adminOnly`). A reader with the permission but another role
 * was refused — and every refusal is itself written to the audit log, so each
 * visit to the audit page by such a reader added a "Verweigert" row about the
 * visit. Ask only when the answer can be yes.
 */
export function canReadDirectory(session: {
  permissions: readonly string[];
  principal: { role_name?: string | null };
}): boolean {
  return session.permissions.includes("identity:read") && session.principal.role_name === "admin";
}

/**
 * WHO acted (§15.2 "Verursacher"): the person's or system account's name where
 * the directory knows it, the kind otherwise — never an id. `null` when the row
 * records no actor at all; the column then shows the dash and infers nothing.
 */
export function auditActorName(
  entry: Pick<AuditEntry, "actor_type" | "actor_id">,
  directory: ReadonlyMap<string, string>,
  t: Translate,
): CatalogLabel | null {
  const kind = entry.actor_type?.trim() ?? "";
  const named = entry.actor_id ? directory.get(entry.actor_id) : undefined;
  if (named) return { text: named, machine: false };
  if (!kind) return null;
  return actorTypeLabel(kind, t);
}

const RESULT_KEYS: Record<string, TranslationKey> = {
  success: "audit.result.success",
  denied: "audit.result.denied",
  error: "audit.result.error",
};

/**
 * How a row's outcome reads.
 *
 * This map sat in the page beside the table while the actor and resource
 * vocabularies lived here. The detail sheet has to print the same word the row
 * printed, and two copies of one map are how a surface and the row it was
 * opened from start disagreeing about what "denied" is called.
 */
export function auditResultLabel(result: string, t: Translate): CatalogLabel {
  return catalogLabel(result, RESULT_KEYS[result], t);
}

/** The engine's reason tokens a reader meets in the log, in words. */
const REASON_KEYS: Record<string, TranslationKey> = {
  expired_sliding: "audit.reason.expiredSliding",
  expired_absolute: "audit.reason.expiredAbsolute",
  idle_timeout: "audit.reason.idleTimeout",
  logout: "audit.reason.logout",
  revoked: "audit.reason.revoked",
  user_deactivated: "audit.reason.userDeactivated",
  bad_signature: "audit.reason.badSignature",
  credential_rejected: "audit.reason.credentialRejected",
  circuit_open: "audit.reason.circuitOpen",
  operator_rejected_confirmation: "audit.reason.operatorRejected",
  execution_authority_required: "audit.reason.authorityRequired",
  execution_authority_unavailable: "audit.reason.authorityUnavailable",
  refresh_replayed: "audit.reason.refreshReplayed",
  manual_re_issue: "audit.reason.manualReissue",
};

/**
 * Why, as the row recorded it. A known token reads as a sentence; an unknown
 * token stays the engine's value, flagged as one; free text the engine wrote is
 * shown as written. `null` when there is no reason.
 */
export function auditReasonLabel(
  reason: string | null | undefined,
  t: Translate,
): CatalogLabel | null {
  const text = reason?.trim() ?? "";
  if (!text) return null;
  if (!/^[a-z][a-z0-9_.:-]*$/.test(text)) return { text, machine: false };
  return catalogLabel(text, REASON_KEYS[text], t);
}

const RESOURCE_KEYS: Record<string, TranslationKey> = {
  workflow: "nav.workflows",
  // Both kinds of decision. Without them the resource column of every decision
  // entry read "Unbekannt" — the log HELD the history and could not name it.
  patch_candidate: "decisions.kind.patch",
  skill_candidate: "decisions.kind.skill",
  connector: "resource.connectors.title",
  knowledge_source: "nav.knowledge",
  skill: "nav.skills",
  file: "nav.files",
  conversation: "nav.chat",
  session: "audit.resource.session",
  credential: "permission.resource.credentials",
  setting: "nav.settings",
  webhook_inbound: "audit.resource.inboundWebhook",
  mcp_oauth_client: "audit.resource.oauthClient",
  mcp_oauth_code: "audit.resource.oauthCode",
  mcp_oauth_token: "audit.resource.oauthToken",
  // Notification fanout records chat.message.sent against the delivery, not
  // against a conversation. It has no detail route, but it still needs a
  // human name in the audit table instead of the forbidden "Unbekannt".
  notification_delivery: "nav.notifications",
  execution: "nav.runs",
  api_key: "nav.apiAccess",
  role: "nav.access",
  user: "nav.people",
  settings: "nav.settings",
  connection: "apiAccess.section.grants",
  schedule: "permission.resource.schedules",
  subscription: "permission.resource.subscriptions",
  inbound_hook: "permission.resource.inboundHooks",
  portal_token: "permission.resource.portalTokens",
  resource_grant: "access.grants",
  group: "access.groups",
  system_account: "audit.actor.systemAccount",
  user_invite: "people.invite",
};

/**
 * What kind of record a row is about.
 *
 * The audit writer is extensible and can introduce a resource before this
 * catalogue knows its noun. The fallback used to be "Weitere Ressource" — a
 * polite "Unbekannt" about a type the log recorded exactly. It is now that
 * type, recognisably a machine value (§15.2).
 */
export function auditResourceLabel(resourceType: string, t: Translate): CatalogLabel {
  return catalogLabel(resourceType, RESOURCE_KEYS[resourceType], t);
}

/**
 * What an audited action IS, in the reader's language.
 *
 * The column used to render `entry.action` verbatim, so the decision history —
 * which the engine has always recorded — arrived as `patch_candidate.approved`
 * and `skill_candidate.rejected`: present, complete, and unreadable. §8.5 is
 * explicit about this case: where the past reaches the log only as a machine
 * value, the naming and the filter belong IN the log, not the sections back in
 * the queue.
 *
 * The map is deliberately partial, and what happens to the rest matters as
 * much as the map. An action nobody has named yet renders as the engine's own
 * string, marked as a machine value — a raw verb is worse than a German one
 * and far better than a word that claims the log recorded nothing.
 *
 * It did the latter for a long time. The fallback resolved to
 * `audit.action.other`, which reads "Weiterer Vorgang" — semantically the
 * banned "Unbekannt" — while this very comment promised the opposite. On a
 * production installation two of the ten visible rows said it, and the
 * paragraph above described behaviour the code did not have.
 */
const ACTION_KEYS: Record<string, TranslationKey> = {
  "approval.requested": "audit.action.approvalRequested",
  "approval.granted": "audit.action.approvalGranted",
  "approval.approved": "audit.action.approvalApproved",
  "approval.rejected": "audit.action.approvalRejected",
  "approval.declined": "audit.action.approvalDeclined",
  "approval.grant_abandoned": "audit.action.approvalAbandoned",
  "approval.dispatch_denied": "audit.action.approvalDispatchDenied",
  "workflow.authority_granted": "audit.action.authorityGranted",
  "workflow.authority_revoked": "audit.action.authorityRevoked",
  "policy.denied": "audit.action.policyDenied",
  "execution.boundary_refused": "audit.action.boundaryRefused",
  "rbac.role_created": "audit.action.roleCreated",
  "rbac.role_deleted": "audit.action.roleDeleted",
  "rbac.permission_granted": "audit.action.permissionGranted",
  "rbac.permission_revoked": "audit.action.permissionRevoked",
  "rbac.user_role_assigned": "audit.action.userRoleAssigned",
  "rbac.user_role_revoked": "audit.action.userRoleRevoked",
  "user.created": "audit.action.userCreated",
  "user.deleted": "audit.action.userDeleted",
  "user.role_changed": "audit.action.userRoleChanged",
  "user.invited": "audit.action.userInvited",
  "api_key.issued": "audit.action.apiKeyIssued",
  "api_key.revoked": "audit.action.apiKeyRevoked",
  "api_key.rotated": "audit.action.apiKeyRotated",
  "session.revoked": "audit.action.sessionRevoked",
  "auth.login_failed": "audit.action.loginFailed",
  "schedule.created": "audit.action.scheduleCreated",
  "schedule.updated": "audit.action.scheduleUpdated",
  "schedule.deleted": "audit.action.scheduleDeleted",
  "workflow.deleted": "audit.action.workflowDeleted",
  "workflow.version_restored": "audit.action.workflowRestored",
  "connector.created": "audit.action.connectorCreated",
  "connector.updated": "audit.action.connectorUpdated",
  "connector.deleted": "audit.action.connectorDeleted",
  "secret.version_created": "audit.action.secretCreated",
  "secret.version_revoked": "audit.action.secretRevoked",
  external_write: "audit.action.externalWrite",
  "execution.aborted": "audit.action.executionAborted",
  "self_healing.scan.completed": "audit.action.healingScanCompleted",
  "patch_candidate.approved": "audit.action.patchApproved",
  "patch_candidate.rejected": "audit.action.patchRejected",
  "patch_candidate.proposed": "audit.action.patchProposed",
  "patch_candidate.auto_applied": "audit.action.patchAutoApplied",
  "patch_candidate.dry_run_requested": "audit.action.patchDryRun",
  // Written by the engine for every repair it proves it cannot make.
  "patch_candidate.closed_inapplicable": "audit.action.patchClosedInapplicable",
  "skill_candidate.approved": "audit.action.skillApproved",
  "skill_candidate.rejected": "audit.action.skillRejected",
  "skill_candidate.proposed": "audit.action.skillProposed",
  "skill_candidate.superseded": "audit.action.skillSuperseded",
  "workflow.created": "audit.action.workflowCreated",
  "workflow.updated": "audit.action.workflowUpdated",
  "execution.started": "audit.action.executionStarted",
  "execution.completed": "audit.action.executionCompleted",
  // A dispatch the runtime stopped because it was outside what a person
  // approved. It reads as its own line, not as "other": a trail that lists its
  // permissions and not its refusals cannot answer whether the limit held.
  // Written on the edge only — a schedule that starts being held, or one whose
  // hold clears. Which of the two it is, is the row's own denied/allowed, so
  // one line covers both directions without the list growing a second entry.
  "schedule.admission.changed": "audit.action.scheduleAdmissionChanged",
  "connector.invoked": "audit.action.connectorInvoked",
  "credential.accessed": "audit.action.credentialAccessed",
  "api_key.used": "audit.action.apiKeyUsed",
  "chat.message.sent": "audit.action.chatMessageSent",
  "session.issued": "audit.action.sessionIssued",
  "connector.mcp_handshake_ok": "audit.action.connectorHandshakeOk",
  "conversation.created": "audit.action.conversationCreated",
  "credential.oauth2_refreshed": "audit.action.credentialRefreshed",
  "credential.rotated": "audit.action.credentialRotated",
  "file.downloaded": "audit.action.fileDownloaded",
  "mcp_oauth.code_issued": "audit.action.oauthCodeIssued",
  "mcp_oauth.consent_denied": "audit.action.oauthConsentDenied",
  "mcp_oauth.consent_granted": "audit.action.oauthConsentGranted",
  "mcp_oauth.token_issued": "audit.action.oauthTokenIssued",
  "mcp_oauth.token_revoked": "audit.action.oauthTokenRevoked",
  "mcp_oauth.token_used": "audit.action.oauthTokenUsed",
  "settings.changed": "audit.action.settingsChanged",
  "user.logged_in": "audit.action.userLoggedIn",
  "webhook.inbound.received": "audit.action.webhookReceived",
  "webhook.inbound.denied": "audit.action.webhookDenied",
  "webhook.inbound.created": "audit.action.webhookCreated",
  "connection.created": "audit.action.connectionCreated",
  "connection.renewed": "audit.action.connectionRenewed",
  "connection.failed": "audit.action.connectionFailed",
  "connection.refreshed": "audit.action.connectionRefreshed",
  "connection.refresh_failed": "audit.action.connectionRefreshFailed",
  "connection.disconnected": "audit.action.connectionDisconnected",
  "secret.version_prepared": "audit.action.secretPrepared",
  "secret.version_approved": "audit.action.secretApproved",
  "secret.version_rejected": "audit.action.secretRejected",
  // Read off the running installation rather than off the enum: 182 distinct
  // verbs have actually been written there, and the map above named 67 of
  // them — 96.31 % of rows, because the long tail is housekeeping. These ten
  // are the remaining ones with real volume that a person either did or would
  // go looking for after an incident. The rest stay machine values on
  // purpose: a verb nobody reads is better shown as the token it is than
  // dressed in prose that was invented for it.
  "conversation.run_workflow": "audit.action.conversationRanWorkflow",
  "tool_policy.confirmation_required": "audit.action.toolPolicyConfirmationRequired",
  "credential.updated": "audit.action.credentialUpdated",
  "settings.revision_saved": "audit.action.settingsRevisionSaved",
  "settings.revision_activated": "audit.action.settingsRevisionActivated",
  "schedule.trigger.fired": "audit.action.scheduleTriggerFired",
  "llm.invocation": "audit.action.llmInvocation",
  "wait.started": "audit.action.waitStarted",
  "wait.completed": "audit.action.waitCompleted",
  "webhook.trigger.failed_verification": "audit.action.webhookVerificationFailed",
};

/**
 * How a row's verb should read.
 *
 * Two shapes, because the caller must be able to tell them apart: a named
 * action is prose, an unnamed one is the engine's own token and has to LOOK
 * like one (§15.2 — the machine value, recognisably as such). Returning a
 * translation key for both is what let the fallback masquerade as a name.
 */
export type AuditActionLabel =
  | { kind: "named"; key: TranslationKey }
  | { kind: "machine"; value: string };

export function auditActionLabel(action: string): AuditActionLabel {
  const key = ACTION_KEYS[action];
  return key ? { kind: "named", key } : { kind: "machine", value: action };
}

/** How many of the engine's verbs this build can name. Read by the coverage guard. */
export function namedActionCount(): number {
  return Object.keys(ACTION_KEYS).length;
}

/**
 * The four verbs that make up the decision history.
 *
 * The engine's `action` filter takes a comma-separated list, so this is one
 * query rather than a client-side sieve over a cursor-paged list — which would
 * have returned short pages and an unusable "next".
 */
export const DECISION_ACTIONS = [
  // Proposals a person accepted or turned down.
  "patch_candidate.approved",
  "patch_candidate.rejected",
  "skill_candidate.approved",
  "skill_candidate.rejected",
  // Permission to act, given and taken away.
  "approval.granted",
  "approval.approved",
  "approval.rejected",
  "approval.declined",
  "workflow.authority_granted",
  "workflow.authority_revoked",
  // Refusals. A denial is a decision the system made on a person's behalf and
  // is the row an auditor looks for first.
  "policy.denied",
  "approval.dispatch_denied",
  "execution.boundary_refused",
  // Who may do what.
  "rbac.role_created",
  "rbac.role_deleted",
  "rbac.permission_granted",
  "rbac.permission_revoked",
  "rbac.user_role_assigned",
  "rbac.user_role_revoked",
  "user.created",
  "user.deleted",
  "user.role_changed",
  "api_key.issued",
  "api_key.revoked",
  // `session.revoked` is deliberately NOT here. The engine writes it itself
  // whenever a sliding session lapses, so on a live installation it arrived
  // ten rows at a time with actor "Engine" and reason "expired_sliding" —
  // filling a view called "decisions" with the housekeeping that view exists
  // to separate out. It is a decision only when a person revokes a session,
  // and the row does not distinguish the two.
  // Things that stop existing, or start running on a clock.
  "workflow.deleted",
  "workflow.version_restored",
  "schedule.created",
  "schedule.deleted",
  "connector.deleted",
  "secret.version_created",
  "secret.version_revoked",
  "settings.changed",
] as const;

/**
 * Which half of the log a reader is looking at.
 *
 * `decisions` is the default and the point of the page: what a person
 * answered for. `operations` is the engine keeping itself alive — token
 * refreshes, key reads, probes — which on a live installation arrives ten
 * rows a minute and buries everything else. Nothing is hidden and nothing is
 * deleted; `all` is one click away and the ordering never changes.
 *
 * The two are filtered on different axes because they are different
 * questions. `decisions` filters by ACTION: a person changing a setting is a
 * decision whoever typed it. `operations` filters by ACTOR: the engine acting
 * on its own account, whatever it happened to be doing. Filtering both by one
 * axis would fold one of the questions into the other.
 */
export type AuditScope = "all" | "decisions" | "operations";

export function isAuditScope(value: unknown): value is AuditScope {
  return value === "all" || value === "decisions" || value === "operations";
}

/** The query narrowing for a scope, as the engine's own parameters. */
export function auditScopeParams(scope: AuditScope): Record<string, string> {
  if (scope === "decisions") return { action: DECISION_ACTIONS.join(",") };
  if (scope === "operations") return { actor_type: "system" };
  return {};
}

/**
 * The correlation key a row was opened with, if any.
 *
 * `trace_id` is the only thing that ties a log row to the request that caused
 * it: the same value appears on the run, on every step, and on each of the
 * engine's own log lines. The page offered no way to filter by it, so a reader
 * holding a red run and a log of thousands of rows had no way from one to the
 * other — §1's "no red without a path to the cause" is unmeetable in a log
 * that cannot be asked "show me this one request".
 *
 * Read from the URL rather than typed, because nobody memorises a trace id:
 * it arrives from whatever surface showed it.
 */
export function auditTraceFromUrl(search: string): string | null {
  const raw = new URLSearchParams(search).get("trace_id")?.trim() ?? "";
  // Bounded, and refused when it could not be one: a free-text value forwarded
  // to the engine as an exact match narrows to nothing and reads like an empty
  // log rather than a bad query.
  if (!raw || raw.length > 128 || !/^[\w-]+$/.test(raw)) return null;
  return raw;
}

/**
 * Everything a link can narrow the log to, read back from its address.
 *
 * The trace was the only narrowing a link could carry, so a record's own page
 * could say "what happened to this workflow" only by sending the reader to the
 * whole log. The engine filters by `resource_type` and `resource_id` as
 * exactly as by `trace_id`; `auditHref` in app/links.ts writes all four and
 * this reads them. Each is bounded like the trace and dropped when it could
 * not be one, for the same reason: an exact match on junk reads as an empty
 * log rather than a bad link. A resource id without its type narrows nothing
 * — the id alone names no record.
 */
export interface AuditLinkFilter {
  resourceType: string | null;
  resourceId: string | null;
  traceId: string | null;
  scope: AuditScope | null;
  /**
   * The verbs a link narrowed to — the overview's repair ratio sends the
   * decided repairs this way. Empty when the link named none.
   */
  actions: string[];
}

/** At most this many verbs from one address; the engine's own lists are shorter. */
const MAX_LINKED_ACTIONS = 32;
const ACTION_TOKEN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;

/**
 * The `action` comma list, each verb checked on its own.
 *
 * One malformed token drops only itself: the rest of the list still names what
 * the link meant, and an exact match on junk would narrow the log to nothing
 * and read as "nothing happened".
 */
export function auditActionsFromUrl(search: string): string[] {
  const raw = new URLSearchParams(search).get("action") ?? "";
  const tokens = raw
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && token.length <= 96 && ACTION_TOKEN.test(token));
  return [...new Set(tokens)].slice(0, MAX_LINKED_ACTIONS);
}

export function auditFilterFromUrl(search: string): AuditLinkFilter {
  const params = new URLSearchParams(search);
  const resourceType = identifierParam(params, "resource_type");
  const scope = params.get("scope");
  return {
    resourceType,
    resourceId: resourceType ? identifierParam(params, "resource_id") : null,
    traceId: auditTraceFromUrl(search),
    scope: isAuditScope(scope) ? scope : null,
    actions: auditActionsFromUrl(search),
  };
}

/**
 * The engine's own parameters for the narrowing a link brought.
 *
 * Applied after the scope's: a link that names its verbs means those verbs,
 * and the "decisions" scope's own `action` list must not silently replace them.
 */
export function auditLinkParams(filter: AuditLinkFilter): Record<string, string> {
  const params: Record<string, string> = {};
  if (filter.resourceType) params.resource_type = filter.resourceType;
  if (filter.resourceId) params.resource_id = filter.resourceId;
  if (filter.traceId) params.trace_id = filter.traceId;
  if (filter.actions.length > 0) params.action = filter.actions.join(",");
  return params;
}

/** The address keys each link narrowing is read from, for lifting one again. */
export const AUDIT_LINK_KEYS = {
  resource: ["resource_type", "resource_id"],
  trace: ["trace_id"],
  actions: ["action"],
} as const;

/**
 * Is this an audit record, or something else that arrived with a 200?
 *
 * The list row already carries all sixteen fields — the engine serializes the
 * same shape for a page and for a single entry — so the sheet's own fetch
 * REFRESHES a record the page already holds rather than filling an empty one.
 * That makes substituting whatever came back dangerous in a way it is not
 * where the fetch IS the data: a mistyped path, a proxy's courtesy page or the
 * visual fixture's catch-all all answer `{ items: [] }` with a 200, and taking
 * that for the record would blank a complete sheet and blame the log for it.
 */
export function isAuditEntry(value: unknown): value is AuditEntry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.ts === "string" &&
    typeof candidate.action === "string"
  );
}

export type AuditEvidenceKind = "before" | "after" | "metadata";

export interface AuditEvidenceBlock {
  kind: AuditEvidenceKind;
  /** The snapshot as the engine stored it, indented to be read. */
  text: string;
}

function formatSnapshot(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}

/**
 * Which of a row's snapshots are evidence, and which are simply not there.
 *
 * `before`, `after` and `metadata` are what the table dropped on the floor: the
 * engine has always returned them, six of sixteen fields reached the screen,
 * and what a recorded change actually changed was readable only from the
 * terminal.
 *
 * Absent and empty are different facts, and they are told apart here rather
 * than in the markup. Only `null`/`undefined` counts as absent — a recorded
 * `false`, `0` or `""` is what the engine wrote and falls out of a falsy test,
 * which would silently delete the evidence that a flag was cleared or a limit
 * set to zero. `metadata` is the one exception and it is an exception about
 * emptiness, not about absence: `{}` is a box with nothing in it, and drawing
 * the box claims the engine recorded something it did not.
 */
export function auditEvidenceBlocks(
  entry: Pick<AuditEntry, "before" | "after" | "metadata">,
): AuditEvidenceBlock[] {
  const blocks: AuditEvidenceBlock[] = [];
  // Before, then after. The pair is read as one change, and a change read
  // backwards states the opposite of what happened.
  for (const kind of ["before", "after"] as const) {
    const value = entry[kind];
    if (value === null || value === undefined) continue;
    blocks.push({ kind, text: formatSnapshot(value) });
  }
  const { metadata } = entry;
  if (metadata && Object.keys(metadata).length > 0) {
    blocks.push({ kind: "metadata", text: formatSnapshot(metadata) });
  }
  return blocks;
}

export interface AuditFact {
  label: string;
  /** `null` is "the engine recorded nothing here"; the surface says so in words. */
  value: string | null;
  /** A machine value — an id, a correlation key, an address — never prose. */
  mono?: boolean;
}

/**
 * A blank text field holds nothing a reader can read.
 *
 * The table already prints the missing marker for an empty string, so folding
 * the two here is what keeps the row and the sheet it opens from stating
 * different things about the same field. This is deliberately NOT the rule for
 * a snapshot: there, `""` is the value the engine stored and stays evidence.
 */
function recordedText(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

/**
 * Everything the engine wrote down about one operation, labelled.
 *
 * The verb itself is not in this list: it is the sheet's title, because a
 * record whose heading is an id tells a reader nothing about what happened.
 * The ids ARE here, each behind its own label — they are what a reader carries
 * into `sk audit show`, a ticket or a second surface, and a trail that hides
 * its own correlation key cannot be followed anywhere.
 */
function labelFact(label: string, value: CatalogLabel | null): AuditFact {
  return value
    ? { label, value: value.text, ...(value.machine ? { mono: true } : {}) }
    : { label, value: null };
}

export function auditDetailFacts(
  entry: AuditEntry,
  t: Translate,
  dateTime: FormatDateTime,
  directory: ReadonlyMap<string, string> = new Map(),
): AuditFact[] {
  return [
    // Absolute. "3 hours ago" is not a fact an auditor can quote.
    { label: t("audit.column.time"), value: dateTime(entry.ts) },
    labelFact(t("audit.column.result"), auditResultLabel(entry.result, t)),
    // Who, then the id behind them. A name alone does not say it is a person
    // record, and a bare id does not say whose it is.
    labelFact(t("audit.column.actor"), auditActorName(entry, directory, t)),
    { label: t("audit.detail.actorId"), value: recordedText(entry.actor_id), mono: true },
    labelFact(t("audit.column.resource"), auditResourceLabel(entry.resource_type, t)),
    { label: t("audit.detail.resourceId"), value: recordedText(entry.resource_id), mono: true },
    labelFact(t("audit.column.reason"), auditReasonLabel(entry.reason, t)),
    { label: t("audit.detail.trace"), value: recordedText(entry.trace_id), mono: true },
    { label: t("audit.detail.ip"), value: recordedText(entry.ip), mono: true },
    { label: t("audit.detail.userAgent"), value: recordedText(entry.user_agent), mono: true },
    { label: t("audit.detail.record"), value: recordedText(entry.id), mono: true },
  ];
}

/**
 * An identifier a reader may need, in a form the cockpit is allowed to print.
 *
 * `konvention:check` reads `body.innerText()` and refuses UUID-shaped text
 * anywhere on the page — with no exemption for a fenced block. That exemption
 * exists in the VISUAL sweep, not in this gate, and a detail sheet that
 * printed `actor_id` in full failed it. UI-UX.md is blunt about it too: an
 * identifier is never what a person reads.
 *
 * So the prefix is shown and the whole value travels in the element's title,
 * where it can still be read and copied. Eight characters is what the CLI
 * prints for a session and is enough to match a row against a log line; the
 * full value is one hover away and, unlike a truncated LABEL, nothing here
 * claims to be the identifier itself.
 */
export function shortIdentifier(value: string): string {
  const looksLikeAnId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
  return looksLikeAnId ? `${value.slice(0, 8)}…` : value;
}
