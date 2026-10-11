import Ajv from "ajv";
import { bounded } from "./limits.ts";

function inspect(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (["$async", "$data"].includes(key))
      throw new Error("Executable or asynchronous schemas are unsupported");
    if ((key === "$ref" || key === "$id") && typeof child === "string" && !child.startsWith("#"))
      throw new Error("Only local schema references are supported");
    inspect(child);
  }
}
export const schema = Object.freeze({
  validate(definition: object | boolean, data: unknown) {
    bounded(definition);
    bounded(data);
    inspect(definition);
    const validator = new Ajv({
      logger: false,
      strict: false,
      allErrors: true,
      validateFormats: false,
      ownProperties: true,
    }).compile(definition);
    const valid = validator(data);
    return {
      valid: Boolean(valid),
      errors: (validator.errors ?? []).map(({ instancePath, keyword, message }) => ({
        path: instancePath,
        keyword,
        message,
      })),
    };
  },
  assert(definition: object | boolean, data: unknown) {
    const result = schema.validate(definition, data);
    if (!result.valid) throw new Error(`SCHEMA_INVALID: ${JSON.stringify(result.errors)}`);
    return data;
  },
});
export function assert(condition: unknown, message = "Assertion failed"): asserts condition {
  if (!condition) throw new Error(message.slice(0, 1024));
}
