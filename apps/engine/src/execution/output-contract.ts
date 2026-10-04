import Ajv, { type ValidateFunction } from "ajv";

function freshAjv(): Ajv {
  return new Ajv({ strict: false, allErrors: true, validateFormats: false });
}

export interface OutputContractViolation {
  path: string;
  message: string;
}

export type OutputContractCheck =
  | { ok: true; valid: true }
  | { ok: true; valid: false; violations: OutputContractViolation[] }
  | { ok: false; schema_error: string };

export function compileOutputContractSchema(
  schema: Record<string, unknown>,
): { ok: true } | { ok: false; error: string } {
  try {
    freshAjv().compile(schema);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function checkOutputContract(
  value: unknown,
  schema: Record<string, unknown>,
): OutputContractCheck {
  let validate: ValidateFunction;
  try {
    validate = freshAjv().compile(schema);
  } catch (err) {
    return { ok: false, schema_error: err instanceof Error ? err.message : String(err) };
  }
  if (validate(value)) return { ok: true, valid: true };
  const violations: OutputContractViolation[] = (validate.errors ?? []).map((e) => {
    const missing =
      e.keyword === "required" &&
      typeof (e.params as { missingProperty?: unknown }).missingProperty === "string"
        ? `/${(e.params as { missingProperty: string }).missingProperty}`
        : "";
    return {
      path: `$output${e.instancePath}${missing}`,
      message: e.message ?? "violates output_schema",
    };
  });
  return { ok: true, valid: false, violations };
}

export function summarizeViolations(
  violations: ReadonlyArray<OutputContractViolation>,
  max = 5,
): string {
  const head = violations
    .slice(0, max)
    .map((v) => `${v.path}: ${v.message}`)
    .join("; ");
  const rest = violations.length > max ? `; +${violations.length - max} more` : "";
  return `${head}${rest}`;
}
