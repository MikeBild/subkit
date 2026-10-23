export const SANDBOX_ECMASCRIPT_GLOBALS: readonly string[] = Object.freeze([
  "AggregateError",
  "Array",
  "ArrayBuffer",
  "BigInt",
  "BigInt64Array",
  "BigUint64Array",
  "Boolean",
  "DataView",
  "Date",
  "Error",
  "EvalError",
  "FinalizationRegistry",
  "Float16Array",
  "Float32Array",
  "Float64Array",
  "Function",
  "Infinity",
  "Int16Array",
  "Int32Array",
  "Int8Array",
  "InternalError",
  "Iterator",
  "JSON",
  "Map",
  "Math",
  "NaN",
  "Number",
  "Object",
  "Promise",
  "Proxy",
  "RangeError",
  "ReferenceError",
  "Reflect",
  "RegExp",
  "Set",
  "SharedArrayBuffer",
  "String",
  "Symbol",
  "SyntaxError",
  "TypeError",
  "URIError",
  "Uint16Array",
  "Uint32Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "WeakMap",
  "WeakRef",
  "WeakSet",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "escape",
  "eval",
  "globalThis",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "undefined",
  "unescape",
]);

export const SANDBOX_STDLIB_GLOBALS: readonly string[] = Object.freeze(["sk", "btoa", "atob"]);

export const SANDBOX_BODY_BINDINGS: readonly string[] = Object.freeze(["input", "arguments"]);

export const SANDBOX_SK_MEMBERS: readonly string[] = Object.freeze([
  "allow",
  "assert",
  "base64Decode",
  "base64DecodeUtf8",
  "base64Encode",
  "base64EncodeUtf8",
  "base64UrlEncode",
  "base64UrlEncodeUtf8",
  "buildMimeMessage",
  "csv",
  "date",
  "deny",
  "diff",
  "documentToMarkdown",
  "emailBody",
  "fmt",
  "get",
  "groupBy",
  "has",
  "hexDecode",
  "hexEncode",
  "hmacSha256",
  "http",
  "isArray",
  "isNil",
  "isNumber",
  "isObject",
  "isString",
  "mimeEncodeHeaderValue",
  "money",
  "now",
  "nowIso",
  "omit",
  "pick",
  "pluck",
  "rfc3339Parts",
  "schema",
  "sha256",
  "template",
  "uniq",
  "url",
  "uuid",
  "version",
  "xml",
]);

export const SANDBOX_SK_FMT_MEMBERS: readonly string[] = Object.freeze(["number", "de"]);

export const SANDBOX_GLOBAL_NAMES: ReadonlySet<string> = new Set([
  ...SANDBOX_ECMASCRIPT_GLOBALS,
  ...SANDBOX_STDLIB_GLOBALS,
  ...SANDBOX_BODY_BINDINGS,
]);

export function sandboxDateFormatHint(): string {
  return SANDBOX_SK_FMT_MEMBERS.includes("date")
    ? 'sk.fmt.date(value, { tz: "Europe/Berlin", pattern: "dd.MM.yyyy" })'
    : 'sk.date.format(value, "dd.MM.yyyy", { zone: "Europe/Berlin" })';
}

export function sandboxNumberFormatHint(): string {
  return 'sk.fmt.number(value, { locale: "de", digits: 1 })';
}

export function renderSandboxGlobalsContract(): string[] {
  return [
    "Sandbox globals (anything else is undefined and fails the lint):",
    `- \`input\`, the ECMAScript built-ins (Array, Object, JSON, Math, Date, Number, String, Map, Set, RegExp, parseInt, encodeURIComponent, …), \`btoa\`/\`atob\` and sk.{${SANDBOX_SK_MEMBERS.join(", ")}} with sk.fmt.{${SANDBOX_SK_FMT_MEMBERS.join(", ")}}.`,
    `- Not available: Intl and .toLocaleString/.toLocaleDateString/.toLocaleTimeString (use ${sandboxNumberFormatHint()} or ${sandboxDateFormatHint()}); Date.now()/Math.random() (use sk.now()/sk.nowIso()/sk.uuid()); fetch, require, import, process, console, timers.`,
    "- Every other identifier must be declared in the body (const/let/function/params) or read from `input`.",
  ];
}
