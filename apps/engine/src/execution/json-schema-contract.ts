import Ajv, { type ValidateFunction } from "ajv";

export interface JsonSchemaViolation {
  path: string;
  message: string;
}

export type JsonSchemaCheck =
  | { ok: true; valid: true }
  | { ok: true; valid: false; violations: JsonSchemaViolation[] }
  | { ok: false; schema_error: string };

function compile(schema: Record<string, unknown>): ValidateFunction {
  if (schema.$async === true) throw new Error("Asynchronous JSON schemas are unsupported.");
  const validate = new Ajv({
    strict: false,
    allErrors: true,
    validateFormats: false,
  }).compile(schema);
  if ("$async" in validate && validate.$async)
    throw new Error("Asynchronous JSON schemas are unsupported.");
  return validate;
}

export function compileJsonSchemaContract(
  schema: Record<string, unknown>,
): { ok: true } | { ok: false; error: string } {
  try {
    compile(schema);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function checkJsonSchemaContract(
  value: unknown,
  schema: Record<string, unknown>,
  location: string,
): JsonSchemaCheck {
  let validate: ValidateFunction;
  try {
    validate = compile(schema);
  } catch {
    return { ok: false, schema_error: "Declared JSON schema is invalid." };
  }
  if (validate(value)) return { ok: true, valid: true };
  return {
    ok: true,
    valid: false,
    violations: (validate.errors ?? []).map((error) => {
      const missing =
        error.keyword === "required" &&
        typeof (error.params as { missingProperty?: unknown }).missingProperty === "string"
          ? `/${(error.params as { missingProperty: string }).missingProperty}`
          : "";
      return {
        path: `${location}${error.instancePath}${missing}`,
        message: error.message ?? "violates JSON schema",
      };
    }),
  };
}
