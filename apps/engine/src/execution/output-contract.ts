import { checkJsonSchemaContract, compileJsonSchemaContract } from "./json-schema-contract.ts";

interface OutputContractViolation {
  path: string;
  message: string;
}

type OutputContractCheck =
  | { ok: true; valid: true }
  | { ok: true; valid: false; violations: OutputContractViolation[] }
  | { ok: false; schema_error: string };

export function compileOutputContractSchema(
  schema: Record<string, unknown>,
): { ok: true } | { ok: false; error: string } {
  return compileJsonSchemaContract(schema);
}

export function checkOutputContract(
  value: unknown,
  schema: Record<string, unknown>,
): OutputContractCheck {
  return checkJsonSchemaContract(value, schema, "$output");
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
