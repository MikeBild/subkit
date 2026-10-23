import type { sandboxTools } from "./tools/index.ts";
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

  /** JSONata-compatible base64 of `input` using one low-8-bit byte per UTF-16 code unit. */
  base64Encode(input: unknown): string;
  /** JSONata-compatible base64url (`+`→`-`, `/`→`_`, padding kept). */
  base64UrlEncode(input: unknown): string;
  /** UTF-8 base64 of `input`; preferred for new Unicode text payloads. */
  base64EncodeUtf8(input: unknown): string;
  /** UTF-8 base64url (`+`→`-`, `/`→`_`, padding kept). */
  base64UrlEncodeUtf8(input: unknown): string;

  /** Inverse of `base64Encode` — Web `atob` (binary-string) semantics. */
  base64Decode(input: unknown): string;
  /** Inverse of `base64EncodeUtf8` — decodes the bytes as UTF-8. */
  base64DecodeUtf8(input: unknown): string;

  /** Lowercase hex of `input` (one low-8-bit byte per UTF-16 code unit). */
  hexEncode(input: unknown): string;
  /** Inverse of `hexEncode` — returns a binary string. */
  hexDecode(input: unknown): string;

  /**
   * RFC 2047 header encoding. ASCII-printable values pass through
   * unchanged; anything else becomes `=?UTF-8?B?…?=` encoded-word(s)
   * folded at the 75-char limit. Email headers are ASCII-only by
   * RFC 5322 — a raw non-ASCII Subject gets Latin-1-mangled by the
   * receiving server ("–" → "Ã¢Â€Â“").
   */
  mimeEncodeHeaderValue(input: unknown): string;
  /**
   * Build a complete RFC822 message and its base64url form (the Gmail
   * `raw` field). Subject/custom headers are RFC-2047-encoded, bodies
   * ride as base64 with UTF-8 charset, html+text together become
   * multipart/alternative. Address fields must be ASCII. Deterministic
   * (content-derived multipart boundary).
   */
  buildMimeMessage(opts: {
    from: string | string[];
    to: string | string[];
    subject?: string;
    html?: string | null;
    text?: string | null;
    cc?: string | string[] | null;
    bcc?: string | string[] | null;
    replyTo?: string | string[] | null;
    /** Extra headers; values are RFC-2047-encoded when non-ASCII. */
    headers?: Record<string, string>;
  }): { raw: string; mime: string };

  /**
   * Decoded text/html bodies of an email message envelope. Generic
   * entry point — the vendor wire format is detected by shape: a Gmail
   * `messages.get` resource/payload tree (nested multipart parts,
   * base64url `body.data`, decoded as UTF-8) or a pre-decoded
   * `{ body: { contentType, content } }` object. Ship THIS, not
   * `snippet` — the snippet is a truncated teaser, not the message.
   */
  emailBody(message: unknown): { text: string | null; html: string | null };

  /**
   * Faithful split of an RFC 3339 date/date-time WITHOUT timezone
   * conversion (the sandbox has no tz database by design). Calendar
   * `dateTime` values already carry the local offset applied; `wall` is
   * the human-facing local time. Date-only input (all-day events)
   * yields `time`/`offset` null. Throws on non-RFC-3339 input. Keep the
   * vendor's separate `timeZone` field alongside — never drop it.
   */
  rfc3339Parts(input: unknown): {
    date: string;
    time: string | null;
    offset: string | null;
    wall: string;
  };

  /**
   * Rich document structure → markdown, preserving annotations
   * (bold/italic/strikethrough/code) and links. Generic entry point —
   * the vendor format is detected by shape: a Notion
   * `blocks.children.list` response, a bare block array (document
   * markdown), or a rich_text span array (inline markdown). Unknown
   * block types degrade to their text content — never silently to "".
   */
  documentToMarkdown(value: unknown): string;

  /** Deterministic SHA-256 over the UTF-8 bytes of `input`, lowercase hex. */
  sha256(input: unknown): string;
  /** Deterministic HMAC-SHA-256(`key`, `msg`) over UTF-8 bytes, lowercase hex. */
  hmacSha256(key: unknown, msg: unknown): string;

  /**
   * Fixed execution timestamp in epoch milliseconds. Deterministic — the
   * same instant for every call in a run. Use instead of the banned
   * `Date.now()` / `new Date()`.
   */
  now(): number;
  /** ISO-8601 string of `now()` (the fixed execution timestamp). */
  nowIso(): string;
  /**
   * Deterministic UUIDv4-shaped id derived from the per-execution seed and
   * a per-context call counter — distinct on each call within a run,
   * identical across replays. Use instead of `Math.random()`-based ids.
   */
  uuid(): string;

  isString(v: unknown): v is string;
  isNumber(v: unknown): v is number;
  isArray(v: unknown): v is unknown[];
  isObject(v: unknown): v is Record<string, unknown>;
  isNil(v: unknown): v is null | undefined;

  /**
   * Locale-aware number and date formatting. This sandbox has no Intl/ECMA-402, and
   * `toLocaleString(locale)` would silently ignore the locale — so formatting
   * lives here instead. Known locales: `de`, `en`.
   */
  readonly fmt: {
    /** `number(9.15, { locale: "de", digits: 1 })` → `"9,2"`. Throws on an unknown locale or a non-finite value. */
    number(
      value: unknown,
      options?: { locale?: string; digits?: number; grouping?: boolean },
    ): string;
    /** Shorthand for German formatting: `de(35606)` → `"35.606"`, `de(9.15, 1)` → `"9,2"`. */
    de(value: unknown, digits?: number): string;
    /**
     * Deterministic date formatting without Intl. `value`: epoch milliseconds, a `Date`, an
     * ISO 8601 date-time with `Z`, `±hh:mm` or `±hhmm`, or a date-only `"yyyy-MM-dd"` (kept as that
     * calendar date, no zone shift, no time tokens). A date-time without an offset throws.
     * `tz` is required: `"UTC"` or `"Europe/Berlin"` (CEST from the last Sunday of March
     * 01:00 UTC to the last Sunday of October 01:00 UTC; Berlin instants before 1996 throw).
     * Other IANA zones: `sk.date.format`. Tokens: `yyyy MMMM MMM MM M dd d EEEE EEE HH H mm ss
     * XXX`; quote literal text (`'Uhr'`); any other letter run throws. `locale` (`de`, `en`;
     * default `en`) names months and weekdays. Default pattern `yyyy-MM-dd'T'HH:mm:ssXXX`.
     * `date("2026-03-29T01:30:00Z", { tz: "Europe/Berlin", locale: "de", pattern: "EEEE, d. MMMM yyyy HH:mm" })`
     * → `"Sonntag, 29. März 2026 03:30"`.
     */
    date(
      value: unknown,
      options: { tz: "UTC" | "Europe/Berlin"; pattern?: string; locale?: string },
    ): string;
  };

  readonly version: string;
}

declare global {
  const sk: Sk;
  /** Web `btoa` — base64 of a binary string (each char one low-8-bit byte). Throws on code points > 255; use `sk.base64EncodeUtf8` for Unicode. */
  function btoa(input: unknown): string;
  /** Web `atob` — inverse of `btoa`, returns a binary string. */
  function atob(input: unknown): string;
}
