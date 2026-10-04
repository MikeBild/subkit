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
