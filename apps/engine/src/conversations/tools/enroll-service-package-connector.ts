import { VERSION } from "@cli-core/version.ts";
import { z } from "@hono/zod-openapi";
import { getDriverFetch } from "../../connectors/drivers/fetch-seam.ts";
import { fetchWithEgressGuard } from "../../connectors/index.ts";
import { getConnector, updateConnector } from "../../connectors/service.ts";
import {
  discoverService,
  resolvePackageArtifactUrl,
} from "../../credentials/connections/discovery.ts";
import { getCredentialForConnector, upsertCredential } from "../../credentials/service.ts";
import { secretComparisonProof } from "../../crypto/aes-gcm.ts";
import { logger } from "../../logging/logger.ts";
import { auditActorFromToolContext, connectorActorFromToolContext } from "./audit-actor.ts";
import type { ConversationTool, ToolContext, ToolResult } from "./index.ts";

const MAX_ENROLLMENT_RESPONSE_BYTES = 16 * 1024;
const timeoutMs = 15_000;
const inputSchema = z
  .object({ connector_id: z.string().uuid().optional() })
  .openapi("EnrollServicePackageConnectorToolInput");

function uuidFromDigest(digest: string): string {
  const bytes = Buffer.from(digest.slice(0, 32), "hex");
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function enrollmentIdentity(
  ctx: ToolContext,
  connector: { id: string; environment: string },
  serviceOrigin: string,
) {
  const context = JSON.stringify([
    ctx.tenant_id,
    connector.id,
    connector.environment,
    serviceOrigin,
  ]);
  const enrollmentId = uuidFromDigest(
    secretComparisonProof("service-package-enrollment-id", context),
  );
  const recoveryProof = Buffer.from(
    secretComparisonProof("service-package-enrollment-proof", context),
    "hex",
  ).toString("base64url");
  return { enrollmentId, recoveryProof };
}

function setupCompleteMessage(ctx: ToolContext, name: string): string {
  return ctx.locale === "en"
    ? `The connection “${name}” is set up.`
    : `Die Verbindung „${name}“ ist eingerichtet.`;
}

function userMessage(ctx: ToolContext, english: string, german: string): string {
  return ctx.locale === "en" ? english : german;
}

function requestBody(template: Record<string, unknown>, label: string): Record<string, unknown> {
  const values: Record<string, string> = {
    "${installation.label}": label,
    "${installation.engine_version}": VERSION,
    "${installation.origin}": "self_hosted",
  };
  const resolve = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (value in values) return values[value];
      if (value.includes("${"))
        throw new Error("service package uses an unsupported enrollment value");
      return value;
    }
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]));
    }
    return value;
  };
  const body = resolve(template);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("service package enrollment body is invalid");
  }
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_ENROLLMENT_RESPONSE_BYTES) {
    throw new Error("service package enrollment body exceeds the allowed size");
  }
  return body as Record<string, unknown>;
}

async function postJson(
  ctx: ToolContext,
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetchWithEgressGuard(
    url,
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json", "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    { tenant_id: ctx.tenant_id, exec: ctx.db },
    { fetchImpl: getDriverFetch() },
  );
  if (!response.body) throw new Error("service enrollment returned no response body");
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_ENROLLMENT_RESPONSE_BYTES) {
    await response.body.cancel();
    throw new Error("service enrollment response exceeds the allowed size");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ENROLLMENT_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("service enrollment response exceeds the allowed size");
    }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("service enrollment returned an invalid response");
  }
  if (!response.ok) {
    throw new Error(`service enrollment request failed (${response.status})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("service enrollment returned an invalid response");
  }
  return parsed as Record<string, unknown>;
}

function serviceEndpoint(baseUrl: string, packageUrl: string, href: string): string {
  const url = resolvePackageArtifactUrl(packageUrl, href);
  if (!url || new URL(url).origin !== new URL(baseUrl).origin) {
    throw new Error("service package enrollment endpoint is not on the connector origin");
  }
  if (new URL(url).protocol !== new URL(baseUrl).protocol) {
    throw new Error("service package enrollment endpoint changed transport security");
  }
  return url;
}

function validHeaderName(name: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name);
}

export const enrollServicePackageConnectorTool: ConversationTool = {
  name: "enroll_service_package_connector",
  description:
    "Securely connect a saved, unauthenticated HTTP connector to a service that publishes the standard SubKit enrollment package. The service returns its credential directly to the engine; the credential is encrypted before acknowledgement and never appears in chat or tool output. Ask the user to approve this external account setup through the normal confirmation flow.",
  use_case:
    "Finish setting up a saved HTTP service connector when its published package describes a recoverable enrollment and encrypted credential acknowledgement flow.",
  important_notes: [
    "Only same-origin HTTPS or local loopback enrollment endpoints are accepted; redirects and oversized responses are rejected.",
    "A deterministic per-tenant, per-environment connector enrollment identity makes retries recover the same service credential until the engine has stored and acknowledged it.",
    "The saved credential is written through the existing encrypted connector credential service and is never returned by this tool.",
  ],
  inputSchema,
  category: "tenant_write",
  authoring_resource: "connector",
  permission: {
    action: "connector:write",
    resourceType: "connector",
    resolveResourceId: async (ctx, rawArgs) =>
      typeof rawArgs.connector_id === "string" ? rawArgs.connector_id : ctx.connector_id,
    denyResult: (permission, reason) => ({
      ok: false,
      error_code: "permission_denied",
      message: reason,
      permission,
    }),
  },
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const connectorId = args.connector_id ?? ctx.connector_id ?? undefined;
    if (!connectorId) {
      return {
        ok: false,
        error_code: "no_connector_in_scope",
        message: userMessage(
          ctx,
          "Choose the service connection you want to finish setting up.",
          "Wähle die Verbindung aus, die du einrichten möchtest.",
        ),
        next_best_actions: ["list_connectors", "get_connector"],
      };
    }
    const connector = await getConnector(ctx.tenant_id, connectorId, ctx.db);
    if (connector?.driver !== "http" || !connector.base_url) {
      return {
        ok: false,
        error_code: "connector_not_eligible",
        message: userMessage(
          ctx,
          "This service connection cannot use the setup published by the service.",
          "Diese Verbindung kann die vom Dienst angebotene Einrichtung nicht verwenden.",
        ),
        data: { connector_id: connectorId },
      };
    }
    if (ctx.principal?.kind !== "user" || ctx.principal.auth_source?.kind !== "browser_session") {
      return {
        ok: false,
        error_code: "user_confirmation_required",
        message: userMessage(
          ctx,
          "A signed-in person must approve this service setup.",
          "Eine angemeldete Person muss diese Einrichtung bestätigen.",
        ),
      };
    }
    if (connector.auth_type !== "none" && connector.auth_type !== "header") {
      return {
        ok: false,
        error_code: "connector_auth_type_conflict",
        message: userMessage(
          ctx,
          "This connection already uses a different sign-in method. Its settings were left unchanged.",
          "Diese Verbindung verwendet bereits eine andere Anmeldung. Ihre Einstellungen bleiben unverändert.",
        ),
        data: { connector_id: connector.id },
      };
    }
    try {
      const discovery = await discoverService(connector.base_url, {
        tenant_id: ctx.tenant_id,
        exec: ctx.db,
      });
      const enrollment = discovery.package?.authentication;
      const packageUrl = discovery.descriptor?.package_url;
      if (!discovery.package || !enrollment) {
        return {
          ok: false,
          error_code: "service_has_no_enrollment_package",
          message: userMessage(
            ctx,
            "This service does not describe an automatic secure setup.",
            "Dieser Dienst bietet keine automatische sichere Einrichtung an.",
          ),
          next_best_actions: ["fetch_connector_self_description", "fetch_connector_docs"],
          data: { connector_id: connector.id },
        };
      }
      if (!packageUrl) throw new Error("service package URL is unavailable");
      if (
        !enrollment.credential.recoverableUntilAcknowledged ||
        !enrollment.recovery.acknowledgeAfterEncryptedStorage ||
        !validHeaderName(enrollment.credential.header) ||
        enrollment.credential.header.toLowerCase() === "authorization" ||
        !validHeaderName(enrollment.recovery.idempotencyHeader) ||
        !validHeaderName(enrollment.recovery.proofHeader) ||
        enrollment.recovery.idempotencyHeader.toLowerCase() ===
          enrollment.recovery.proofHeader.toLowerCase() ||
        [enrollment.recovery.idempotencyHeader, enrollment.recovery.proofHeader].some((name) =>
          ["authorization", "content-type", "host"].includes(name.toLowerCase()),
        ) ||
        [
          enrollment.credential.header,
          enrollment.recovery.idempotencyHeader,
          enrollment.recovery.proofHeader,
        ].some((name, index, all) =>
          all.slice(0, index).some((prior) => prior.toLowerCase() === name.toLowerCase()),
        ) ||
        !/^[A-Za-z0-9._~-]{1,64}$/.test(enrollment.credential.prefix) ||
        !/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(enrollment.credential.responseField)
      ) {
        return {
          ok: false,
          error_code: "service_enrollment_package_invalid",
          message: userMessage(
            ctx,
            "The service setup instructions could not be verified.",
            "Die Einrichtungshinweise des Dienstes konnten nicht geprüft werden.",
          ),
          data: { connector_id: connector.id },
        };
      }
      const prior = await getCredentialForConnector(
        ctx.tenant_id,
        connector.id,
        connector.environment,
        ctx.db,
      );
      const priorValue = prior?.value;
      if (priorValue?.mode === "header") {
        const existingSecret = Object.entries(priorValue.headers).find(
          ([name, value]) =>
            name.toLowerCase() === enrollment.credential.header.toLowerCase() &&
            value.startsWith(enrollment.credential.prefix),
        )?.[1];
        if (!existingSecret) {
          return {
            ok: false,
            error_code: "connector_credential_conflict",
            message: userMessage(
              ctx,
              "This connection already has different sign-in details. They were left unchanged.",
              "Diese Verbindung hat bereits andere Anmeldedaten. Sie bleiben unverändert.",
            ),
            data: { connector_id: connector.id },
          };
        }
        if (connector.auth_type === "none") {
          await updateConnector(
            ctx.tenant_id,
            connector.id,
            { auth_type: "header" },
            connectorActorFromToolContext(ctx),
            ctx.db,
          );
        }
        const endpoint = serviceEndpoint(
          connector.base_url,
          packageUrl,
          enrollment.acknowledgement,
        );
        const identity = enrollmentIdentity(ctx, connector, new URL(connector.base_url).origin);
        const ack = await postJson(
          ctx,
          endpoint,
          {
            authorization: `Bearer ${existingSecret}`,
            [enrollment.recovery.idempotencyHeader]: identity.enrollmentId,
            [enrollment.recovery.proofHeader]: identity.recoveryProof,
          },
          {},
        );
        if (ack.acknowledged !== true)
          throw new Error("service did not confirm credential storage");
        return {
          ok: true,
          data: {
            message: setupCompleteMessage(ctx, connector.display_name ?? connector.slug),
            already_connected: true,
            next_best_actions: [
              "fetch_connector_self_description",
              "prepare_service_package_workflow",
            ],
          },
        };
      }
      if (prior) {
        return {
          ok: false,
          error_code: "connector_credential_conflict",
          message: userMessage(
            ctx,
            "This connection already has sign-in details. They were left unchanged.",
            "Diese Verbindung hat bereits Anmeldedaten. Sie bleiben unverändert.",
          ),
          data: { connector_id: connector.id },
        };
      }
      const identity = enrollmentIdentity(ctx, connector, new URL(connector.base_url).origin);
      const body = requestBody(enrollment.request.body, connector.display_name ?? connector.slug);
      const endpoint = serviceEndpoint(connector.base_url, packageUrl, enrollment.endpoint);
      const registration = await postJson(
        ctx,
        endpoint,
        {
          [enrollment.recovery.idempotencyHeader]: identity.enrollmentId,
          [enrollment.recovery.proofHeader]: identity.recoveryProof,
        },
        body,
      );
      const secret = registration[enrollment.credential.responseField];
      if (
        typeof secret !== "string" ||
        !secret.startsWith(enrollment.credential.prefix) ||
        secret.length > 512 ||
        /\s/.test(secret)
      ) {
        throw new Error("service returned an invalid credential");
      }
      const actor = auditActorFromToolContext(ctx);
      await ctx.db.transaction(async (tx) => {
        const updated = await updateConnector(
          ctx.tenant_id,
          connector.id,
          { auth_type: "header" },
          connectorActorFromToolContext(ctx),
          tx,
        );
        if (!updated) throw new Error("service connector disappeared during setup");
        await upsertCredential(
          {
            tenant_id: ctx.tenant_id,
            connector_id: connector.id,
            environment: connector.environment,
            mode: "header",
            value: { mode: "header", headers: { [enrollment.credential.header]: secret } },
            actor_id: actor.actor_id,
            actor_type: actor.actor_type,
            source: "service_package_enrollment",
          },
          tx,
        );
      });
      const ackEndpoint = serviceEndpoint(
        connector.base_url,
        packageUrl,
        enrollment.acknowledgement,
      );
      const ack = await postJson(
        ctx,
        ackEndpoint,
        {
          authorization: `Bearer ${secret}`,
          [enrollment.recovery.idempotencyHeader]: identity.enrollmentId,
          [enrollment.recovery.proofHeader]: identity.recoveryProof,
        },
        {},
      );
      if (ack.acknowledged !== true) throw new Error("service did not confirm credential storage");
      logger.info({
        module: "conversation_tool",
        action: "service_package.enrollment_completed",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        connector_id: connector.id,
        package_id: discovery.package.id,
        package_version: discovery.package.version,
      });
      return {
        ok: true,
        data: {
          message: setupCompleteMessage(ctx, connector.display_name ?? connector.slug),
          already_connected: false,
          next_best_actions: [
            "fetch_connector_self_description",
            "prepare_service_package_workflow",
          ],
        },
      };
    } catch (err) {
      logger.warn({
        module: "conversation_tool",
        action: "service_package.enrollment_failed",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        connector_id: connector.id,
        error_type: err instanceof Error ? err.name : "unknown",
        error_code:
          typeof (err as { code?: unknown }).code === "string"
            ? (err as { code: string }).code
            : null,
        status:
          typeof (err as { status?: unknown }).status === "number"
            ? (err as { status: number }).status
            : null,
      });
      return {
        ok: false,
        error_code: "service_package_enrollment_failed",
        message: userMessage(
          ctx,
          "The connection could not be set up yet. You can try again; any existing sign-in details remain protected.",
          "Die Verbindung konnte noch nicht eingerichtet werden. Du kannst es erneut versuchen; vorhandene Anmeldedaten bleiben geschützt.",
        ),
        next_best_actions: ["enroll_service_package_connector", "fetch_connector_self_description"],
        data: { connector_id: connector.id },
      };
    }
  },
};
