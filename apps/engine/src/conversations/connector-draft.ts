import {
  validateConnectorConfig,
  validateMcpAuthConsistency,
} from "../connectors/config-schemas.ts";
import { validateConnectorAuthType, validateSftpAuthConsistency } from "../connectors/index.ts";
import type { ConnectorTemplate } from "../connectors/templates.ts";
import { getBuiltinTemplate } from "../connectors/templates.ts";
import type { CreateConnectorInput } from "../connectors/types.ts";
import {
  allowedTemplateAuthTypes,
  defaultTemplateAuthType,
  extractTemplatePlaceholders,
} from "./connector-template-intelligence.ts";
import type { ConnectorDraftDocument } from "./types.ts";

interface ConnectorDraftValidation {
  ok: boolean;
  missing_fields: string[];
  errors: Array<{ path: string; message: string }>;
}

function pushError(
  errors: Array<{ path: string; message: string }>,
  path: string,
  message: string,
): void {
  errors.push({ path, message });
}

const PLACEHOLDER_HOST_PATTERNS: ReadonlyArray<RegExp> = [
  /\bexample\.(com|net|org)\b/i,
  /\bplaceholder\b/i,
  /\byour[-_]?(host|domain|api|company|tenant|engine|server)/i,
  /\b(api\.)?your-/i,
  /<[^>]*>/,
  /\[(YOUR|HOST|API|TOKEN|KEY)[^\]]*]/i,
];

function looksLikePlaceholderUrl(raw: string): boolean {
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    return false;
  }
  for (const pattern of PLACEHOLDER_HOST_PATTERNS) {
    if (pattern.test(host) || pattern.test(raw)) return true;
  }
  return false;
}

export function validateConnectorDraft(
  connector: ConnectorDraftDocument | null,
  templates: ConnectorTemplate[],
): ConnectorDraftValidation {
  const missing_fields: string[] = [];
  const errors: Array<{ path: string; message: string }> = [];
  if (!connector) {
    return {
      ok: false,
      missing_fields: ["connector"],
      errors: [{ path: "connector", message: "start a connector draft first" }],
    };
  }
  if (!connector.name) missing_fields.push("name");
  if (!connector.driver) missing_fields.push("driver");
  if (!connector.environment) missing_fields.push("environment");
  if (!connector.auth_type) missing_fields.push("auth_type");

  if (
    connector.driver === "http" ||
    connector.driver === "graphql" ||
    connector.driver === "s3" ||
    connector.driver === "sftp" ||
    connector.driver === "mcp"
  ) {
    if (!connector.base_url) missing_fields.push("base_url");
    else {
      const placeholders = extractTemplatePlaceholders(connector.base_url);
      if (placeholders.length > 0) {
        for (const field of placeholders) {
          missing_fields.push(`base_url.${field}`);
        }
      } else {
        try {
          new URL(connector.base_url);
        } catch {
          pushError(errors, "base_url", "base_url must be a valid URL");
        }
        if (looksLikePlaceholderUrl(connector.base_url)) {
          pushError(
            errors,
            "base_url",
            "base_url looks like a placeholder (example.com / localhost / 127.0.0.1 / your-host). Ground from runtime context, the connector template, or ask the user — never invent a host.",
          );
        }
      }
    }
  }
  if (connector.driver === "postgres") {
    if (!connector.dsn) missing_fields.push("dsn");
    else if (
      !connector.dsn.startsWith("postgres://") &&
      !connector.dsn.startsWith("postgresql://")
    ) {
      pushError(errors, "dsn", "dsn must start with postgres:// or postgresql://");
    }
  }
  if (connector.slug && !/^[a-z0-9][a-z0-9-]*$/u.test(connector.slug)) {
    pushError(errors, "slug", "slug must match /^[a-z0-9][a-z0-9-]*$/");
  }
  if (connector.driver) {
    errors.push(
      ...validateConnectorConfig(connector.driver, connector.config),
      ...validateConnectorAuthType(connector.driver, connector.auth_type),
      ...validateMcpAuthConsistency(connector.driver, connector.auth_type, connector.config),
      ...validateSftpAuthConsistency(connector.driver, connector.auth_type, connector.config),
    );
  }
  if (connector.template_slug) {
    const template =
      templates.find((candidate) => candidate.slug === connector.template_slug) ??
      getBuiltinTemplate(connector.template_slug);
    if (!template) {
      pushError(errors, "template_slug", "template_slug must reference a known connector template");
    } else {
      if (connector.driver && template.driver !== connector.driver) {
        pushError(
          errors,
          "template_slug",
          `template '${template.slug}' uses driver '${template.driver}' and cannot be bound to a '${connector.driver}' connector`,
        );
      }
      if (connector.auth_type) {
        const allowed = allowedTemplateAuthTypes(template);
        if (!allowed.includes(connector.auth_type)) {
          pushError(
            errors,
            "auth_type",
            `auth_type must match the selected template (${allowed.join(", ")}; default ${defaultTemplateAuthType(template)})`,
          );
        }
      }
      if (connector.driver === "graphql" && template.url_pattern && connector.base_url) {
        const placeholders = extractTemplatePlaceholders(connector.base_url);
        if (placeholders.length === 0) {
          let pattern: RegExp | null = null;
          try {
            pattern = new RegExp(template.url_pattern);
          } catch {
            pattern = null;
          }
          if (pattern && !pattern.test(connector.base_url)) {
            pushError(
              errors,
              "base_url",
              `base_url must be the full GraphQL endpoint URL matching the ${template.name} pattern (${template.url_pattern}) — include the endpoint path (e.g. /graphql), do not trim it to the host root`,
            );
          }
        }
      }
    }
  }
  return {
    ok: missing_fields.length === 0 && errors.length === 0,
    missing_fields,
    errors,
  };
}

export function toCreateConnectorInput(connector: ConnectorDraftDocument): CreateConnectorInput {
  return {
    name: connector.name ?? "untitled-connector",
    ...(connector.slug ? { slug: connector.slug } : {}),
    driver: connector.driver ?? "http",
    environment: connector.environment ?? "dev",
    ...(connector.base_url ? { base_url: connector.base_url } : {}),
    ...(connector.dsn ? { dsn: connector.dsn } : {}),
    auth_type: connector.auth_type ?? "none",
    ...(connector.config ? { config: connector.config } : {}),
    ...(connector.template_slug ? { template_slug: connector.template_slug } : {}),
    ...(connector.template_source ? { template_source: connector.template_source } : {}),
  };
}
