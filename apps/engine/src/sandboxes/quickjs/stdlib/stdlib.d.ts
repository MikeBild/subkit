// Ambient type declarations for the `sk` global exposed inside the
// QuickJS sandbox. Not used at runtime — consumed by the LLM-authoring
// surface (skills, docs generation) and by any engine-side code that
// needs to reason about the stdlib shape.

export interface SkHttp {
  isMutating(method: unknown): boolean;
  isSafe(method: unknown): boolean;
  readonly METHODS: {
    readonly READ: readonly ["GET", "HEAD", "OPTIONS"];
    readonly WRITE: readonly ["POST", "PUT", "PATCH", "DELETE"];
  };
}

export interface SkDecision {
  allow: boolean;
  reason?: string;
}

export interface Sk {
  readonly http: SkHttp;

  get<T = unknown>(obj: unknown, path: string | readonly string[], fallback?: T): T;
  has(obj: unknown, path: string | readonly string[]): boolean;

  allow(): { allow: true };
  deny(reason: string): { allow: false; reason: string };

  pick<T extends Record<string, unknown>, K extends keyof T>(
    obj: T,
    keys: readonly K[],
  ): Pick<T, K>;
  omit<T extends Record<string, unknown>, K extends keyof T>(
    obj: T,
    keys: readonly K[],
  ): Omit<T, K>;

  pluck<T, K extends keyof T>(arr: readonly T[], key: K): Array<T[K]>;
  groupBy<T>(
    arr: readonly T[],
    keyOrFn: keyof T | ((item: T) => string | number | null | undefined),
  ): Record<string, T[]>;
  uniq<T>(arr: readonly T[]): T[];

  /** UTF-8 base64 of `input` (matches jsonata `$base64encode`). */
  base64Encode(input: unknown): string;
  /** UTF-8 base64url (`+`→`-`, `/`→`_`, padding kept) — Gmail `raw`. */
  base64UrlEncode(input: unknown): string;

  isString(v: unknown): v is string;
  isNumber(v: unknown): v is number;
  isArray(v: unknown): v is unknown[];
  isObject(v: unknown): v is Record<string, unknown>;
  isNil(v: unknown): v is null | undefined;

  readonly version: string;
}

declare global {
  const sk: Sk;
}
