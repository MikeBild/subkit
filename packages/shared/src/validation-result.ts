// Shared validation-result shapes. Replaces three coexisting forms:
//   - workflows/validator.ts `validateWorkflowDef` → `{ ok, workflow?, errors }`
//   - llm/flows/discover.ts `validateDiscoverDraft` → `string[] | null`
//   - llm/flows/extract.ts `validateExtractRoundtrip` → `{ status, issues }`
// Adopt one binary shape for pass/fail, one tristate for roundtrip.

export type ValidationResult<P = void, E = ValidationIssue> =
  | { valid: true; payload: P }
  | { valid: false; errors: readonly E[] };

export interface ValidationIssue {
  code: string;
  message: string;
  path?: ReadonlyArray<string | number>;
}

export function ok<P>(payload: P): ValidationResult<P> {
  return { valid: true, payload };
}

export function fail<E>(errors: readonly E[]): ValidationResult<never, E> {
  return { valid: false, errors };
}
