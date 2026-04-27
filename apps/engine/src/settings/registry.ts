// Settings registry — single source of truth for every runtime-tunable
// value in the engine.
//
// Adding a new setting is a one-row change: declare a `SettingSpec`
// here and the service exposes get/set/list automatically. The
// registry powers:
//
//   - Zod validation in `service.set` (each value parses through `schema`).
//   - Secret masking in `service.list` and `sk settings list` (the
//     `secret: true` flag).
//   - Default resolution: `service.get` returns the default when no
//     row exists in either `engine_settings` or `tenants.settings`.
//   - Documentation surfaces (`description` + `category`) for the
//     `sk settings configure` interactive wizard.
//
// Settings are scoped two ways:
//
//   - "global": stored in `engine_settings` keyed by `key`. Used for
//     LLM provider keys, OIDC issuer URLs, observability endpoints.
//   - "tenant": stored in `tenants.settings` JSONB keyed by `key`,
//     with the global value as fallback. Used for token budgets,
//     queue concurrency overrides, feature flags.

import { z } from "zod";

export type SettingScope = "global" | "tenant";

export interface SettingSpec<S extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Stable key persisted in storage and surfaced via `sk settings`. */
  key: string;
  /** Human label shown by `sk settings configure`. */
  label: string;
  /** One-line operator-facing description. */
  description: string;
  /** Storage location. `tenant` settings fall through to `global` then default. */
  scope: SettingScope;
  /** Group name for the interactive wizard (LLM, Observability, OAuth, …). */
  category: string;
  /** Zod schema. The persisted JSONB MUST parse through this. */
  schema: S;
  /** Default value when no row is set anywhere. */
  default: z.infer<S>;
  /** When true: masked in lists, redacted in audit_log diffs, and
   *  scrubbed before being returned by anything other than the engine
   *  process that needs the live value. */
  secret?: boolean;
}

/**
 * The full registry. Order is purely for readability — service.list()
 * preserves it so the `sk settings configure` wizard walks categories
 * top-down.
 */
export const SETTING_SPECS: ReadonlyArray<SettingSpec> = [
  // ----- LLM provider configuration --------------------------------------
  {
    key: "llm.provider",
    label: "LLM provider",
    description: "Primary LLM provider for authoring and execution.",
    scope: "global",
    category: "LLM",
    schema: z.enum(["mock", "anthropic", "openai", "gemini", "azure", "bedrock", "vertex"]),
    default: "mock",
  },
  {
    key: "llm.api_key",
    label: "LLM API key",
    description: "API key for the configured LLM provider. Empty until bootstrap.",
    scope: "global",
    category: "LLM",
    schema: z.string(),
    default: "",
    secret: true,
  },
  {
    key: "llm.model",
    label: "LLM model",
    description:
      "Model identifier sent to the provider (e.g. claude-sonnet-4-5). Empty until bootstrap.",
    scope: "global",
    category: "LLM",
    schema: z.string(),
    default: "",
  },
  {
    key: "llm.fallback_provider",
    label: "Fallback LLM provider",
    description: "Second-choice provider used when the primary returns retryable errors.",
    scope: "global",
    category: "LLM",
    schema: z
      .enum(["mock", "anthropic", "openai", "gemini", "azure", "bedrock", "vertex"])
      .nullable(),
    default: null,
  },

  // ----- Observability ---------------------------------------------------
  {
    key: "observability.langfuse_host",
    label: "Langfuse host",
    description: "Base URL for Langfuse trace ingestion. Empty string disables.",
    scope: "global",
    category: "Observability",
    schema: z.string(),
    default: "",
  },
  {
    key: "observability.langfuse_public_key",
    label: "Langfuse public key",
    description: "Public key for Langfuse.",
    scope: "global",
    category: "Observability",
    schema: z.string(),
    default: "",
  },
  {
    key: "observability.langfuse_secret_key",
    label: "Langfuse secret key",
    description: "Secret key for Langfuse.",
    scope: "global",
    category: "Observability",
    schema: z.string(),
    default: "",
    secret: true,
  },
  {
    key: "observability.otlp_endpoint",
    label: "OTLP endpoint",
    description: "OpenTelemetry trace endpoint (HTTP).",
    scope: "global",
    category: "Observability",
    schema: z.string(),
    default: "",
  },

  // ----- Per-tenant operational tuning -----------------------------------
  {
    key: "queue.concurrency",
    label: "Queue concurrency",
    description: "Max concurrent step executions per worker.",
    scope: "tenant",
    category: "Queue",
    schema: z.number().int().positive().max(64),
    default: 8,
  },
  {
    key: "tokens.monthly_budget",
    label: "Monthly token budget",
    description: "Hard cap on tokens consumed per calendar month. 0 = unlimited.",
    scope: "tenant",
    category: "LLM",
    schema: z.number().int().nonnegative(),
    default: 0,
  },

  // ----- Public base URL (used by the /install routes + chat link replies)
  {
    key: "engine.public_base_url",
    label: "Public engine base URL",
    description: "External-facing URL the engine resolves at (used by /install).",
    scope: "global",
    category: "Engine",
    schema: z.string(),
    default: "",
  },
];

export type SettingKey = string;

const SPEC_BY_KEY = new Map<string, SettingSpec>(SETTING_SPECS.map((s) => [s.key, s]));

export function getSpec(key: string): SettingSpec | undefined {
  return SPEC_BY_KEY.get(key);
}

export function listSpecs(): SettingSpec[] {
  return [...SETTING_SPECS];
}

export function specsByCategory(): Record<string, SettingSpec[]> {
  const out: Record<string, SettingSpec[]> = {};
  for (const spec of SETTING_SPECS) {
    const bucket = out[spec.category] ?? [];
    bucket.push(spec);
    out[spec.category] = bucket;
  }
  return out;
}

/**
 * Return a redacted copy of the value when the spec is marked secret.
 * Unset secrets render as empty string so JSON consumers can tell
 * "set" from "unset" without ever seeing the underlying material.
 */
export function maskValue(spec: SettingSpec, value: unknown): unknown {
  if (!spec.secret) return value;
  if (value === undefined || value === null || value === "") return value;
  return "***";
}
