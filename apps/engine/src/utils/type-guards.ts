// Tiny runtime type guards. Co-located here so any module can `import
// { isRecord } from "@engine/utils/type-guards.ts"` instead of inlining
// the same one-liner.
//
// Only `isRecord` is exported today. Add more guards (`isString`,
// `isNumber`, ...) only when a real consumer needs one — keeping the
// file lean prevents drift between this module and the bespoke
// `typeof === "string"` patterns elsewhere.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
