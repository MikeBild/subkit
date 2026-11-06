import { INVOKE_ENVIRONMENTS, isInvokeEnvironment } from "@shared/invoke-snippet.ts";
import type { RunEnvironment } from "../engine-client.ts";

const RUN_ENVIRONMENTS = INVOKE_ENVIRONMENTS;
const DEFAULT_RUN_ENVIRONMENT: RunEnvironment = "dev";
const ENVIRONMENT_MISMATCH_CODE = "connector_environment_mismatch";

export const RUN_ENVIRONMENT_ARG = {
  type: "string",
  default: DEFAULT_RUN_ENVIRONMENT,
  description:
    "Where the run executes: dev (default) or prod. Sent as the x-subkit-environment header; write steps need a connector bound to this environment.",
} as const;

export function parseRunEnvironment(raw: unknown): RunEnvironment | null {
  const value = raw === undefined || raw === null ? DEFAULT_RUN_ENVIRONMENT : String(raw).trim();
  return isInvokeEnvironment(value) ? value : null;
}

export function invalidRunEnvironmentMessage(raw: unknown): string {
  return `invalid --environment '${String(raw)}' (expected ${RUN_ENVIRONMENTS.join("|")})`;
}

function mentionsCode(value: unknown, code: string, depth = 0): boolean {
  if (depth > 8 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => mentionsCode(item, code, depth + 1));
  const record = value as Record<string, unknown>;
  if (record.code === code || record.error_code === code) return true;
  return Object.values(record).some((item) => mentionsCode(item, code, depth + 1));
}

export function environmentMismatchHint(
  value: unknown,
  environment: RunEnvironment,
): string | null {
  if (!mentionsCode(value, ENVIRONMENT_MISMATCH_CODE)) return null;
  const other = environment === "prod" ? "dev" : "prod";
  return `This run used --environment ${environment}, but a write step's connector is bound to another environment. Run again with --environment ${other}, or bind the connector to ${environment}.`;
}
