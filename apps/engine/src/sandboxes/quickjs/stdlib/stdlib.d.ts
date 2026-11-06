import type { sandboxTools } from "./tools/index.ts";

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

export interface Sk extends Readonly<typeof sandboxTools> {
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

  base64Encode(input: unknown): string;
  base64UrlEncode(input: unknown): string;
  base64EncodeUtf8(input: unknown): string;
  base64UrlEncodeUtf8(input: unknown): string;

  base64Decode(input: unknown): string;
  base64DecodeUtf8(input: unknown): string;

  hexEncode(input: unknown): string;
  hexDecode(input: unknown): string;

  mimeEncodeHeaderValue(input: unknown): string;
  buildMimeMessage(opts: {
    from: string | string[];
    to: string | string[];
    subject?: string;
    html?: string | null;
    text?: string | null;
    cc?: string | string[] | null;
    bcc?: string | string[] | null;
    replyTo?: string | string[] | null;
    headers?: Record<string, string>;
  }): { raw: string; mime: string };

  emailBody(message: unknown): { text: string | null; html: string | null };

  rfc3339Parts(input: unknown): {
    date: string;
    time: string | null;
    offset: string | null;
    wall: string;
  };

  documentToMarkdown(value: unknown): string;

  sha256(input: unknown): string;
  hmacSha256(key: unknown, msg: unknown): string;

  now(): number;
  nowIso(): string;
  uuid(): string;

  isString(v: unknown): v is string;
  isNumber(v: unknown): v is number;
  isArray(v: unknown): v is unknown[];
  isObject(v: unknown): v is Record<string, unknown>;
  isNil(v: unknown): v is null | undefined;

  readonly fmt: {
    number(
      value: unknown,
      options?: { locale?: string; digits?: number; grouping?: boolean },
    ): string;
    de(value: unknown, digits?: number): string;
    date(
      value: unknown,
      options: { tz: "UTC" | "Europe/Berlin"; pattern?: string; locale?: string },
    ): string;
  };

  readonly version: string;
}

declare global {
  const sk: Sk;
  function btoa(input: unknown): string;
  function atob(input: unknown): string;
}
