import type { ConnectorTemplate } from "../connectors/templates.ts";
import { getBuiltinTemplate } from "../connectors/templates.ts";
import type { CreateConnectorInput } from "../connectors/types.ts";
import {
  allowedTemplateAuthTypes,
  defaultTemplateAuthType,
  extractTemplatePlaceholders,
} from "./connector-template-intelligence.ts";
import type { ConnectorDraftDocument } from "./types.ts";

export interface ConnectorDraftValidation {
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

// Refuse base_urls that obviously came from a model hallucination instead
// of grounded tenant context. Catches the shapes models actually invent:
// the `example.*` family (RFC 2606 reserved), `placeholder` literals, and
// `your-host` / `<YOUR_HOST>` style templates. Loopback (`localhost`,
// `127.0.0.1`) is intentionally NOT in this list — real dev / test setups
// legitimately point at local stubs, and models rarely hallucinate
// loopback as a fabricated production target.
const PLACEHOLDER_HOST_PATTERNS: ReadonlyArray<RegExp> = [
  /\bexample\.(com|net|org)\b/i,
  /\bplaceholder\b/i,
  /\byour[-_]?(host|domain|api|company|tenant|engine|server)/i,
  /\b(api\.)?your-/i,
  /<[^>]*>/, // angle-bracket templating like <YOUR_HOST>
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
  templates?: ConnectorTemplate[],
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

  if (connector.driver === "http" || connector.driver === "graphql" || connector.driver === "s3") {
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
  if (connector.template_slug) {
    const template =
      templates?.find((candidate) => candidate.slug === connector.template_slug) ??
      getBuiltinTemplate(connector.template_slug);
    if (!template) {
      pushError(errors, "template_slug", "template_slug must reference a known connector template");
    } else if (connector.auth_type) {
      const allowed = allowedTemplateAuthTypes(template);
      if (!allowed.includes(connector.auth_type)) {
        pushError(
          errors,
          "auth_type",
          `auth_type must match the selected template (${allowed.join(", ")}; default ${defaultTemplateAuthType(template)})`,
        );
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
