import { z } from "@hono/zod-openapi";

export const expression = z
  .string()
  .regex(/^(?:(?:item|input|scope)(?:\.[A-Za-z_][A-Za-z0-9_]*)+|caller\.(?:subject|principalId))$/);
const VARIABLES_KEY_ERROR =
  "a `variables` key is the placeholder expression without its `${}`, rooted at `input`, " +
  "`scope` or `item` — for example `scope.window.data.start` or `item.id` — or one of " +
  "`caller.subject` and `caller.principalId` with the rule `{ caller_bound: true }`. A query " +
  "parameter's name or a path segment's label is not a key.";
export const variablesError = (issue: { code?: string }) =>
  issue.code === "invalid_key" ? VARIABLES_KEY_ERROR : undefined;

const isControlCharacter = (character: string) => {
  const code = character.charCodeAt(0);
  return code <= 0x1f || code === 0x7f;
};

const enumValue = z
  .string()
  .regex(/^(?:[A-Za-z0-9._~:-]|%[0-9A-Fa-f]{2}){1,200}$/)
  .refine((value) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      return false;
    }
    if (decoded.includes("\\") || [...decoded].some(isControlCharacter)) return false;
    return !decoded.split("/").some((part) => part === "." || part === "..");
  });
export const VALUE_CLASSES = {
  identifier: /^[A-Za-z0-9_-]{1,200}$/,
  long_identifier: /^[A-Za-z0-9_-]{1,1024}$/,
  uuid: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/,
  integer: /^(0|[1-9][0-9]{0,18})$/,
  date: /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/,
  timestamp: /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$/,
  timestamp_range: /^>=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$/,
  file_name: /^[A-Za-z0-9_-]{1,200}\.[A-Za-z0-9]{1,16}$/,
  path: /^(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})*(?:\/(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})*)*$/,
} as const;
const MAX_PATH_VALUE = 1024;
export type ValueClass = keyof typeof VALUE_CLASSES;
const VALUE_CLASS_NAMES = Object.keys(VALUE_CLASSES) as [ValueClass, ...ValueClass[]];
const HEADER_CLASS_NAMES = VALUE_CLASS_NAMES.filter((name) => name !== "path") as [
  ValueClass,
  ...ValueClass[],
];
export const CLASS_SAMPLE: Record<ValueClass, string> = {
  identifier: "a",
  long_identifier: "a",
  uuid: "00000000-0000-4000-8000-000000000000",
  integer: "0",
  date: "2000-01-01",
  timestamp: "2000-01-01T00:00:00Z",
  timestamp_range: ">=2000-01-01T00:00:00Z",
  file_name: "a.a",
  path: "a",
};

const enumRule = z.object({ enum: z.array(enumValue).min(1).max(50) }).strict();
export const rule = z.union([
  enumRule,
  z.object({ class: z.enum(VALUE_CLASS_NAMES) }).strict(),
  z.object({ caller_bound: z.literal(true) }).strict(),
]);
export type RequestVariableRule = z.infer<typeof rule>;
export const headerRule = z.union([
  enumRule,
  z.object({ class: z.enum(HEADER_CLASS_NAMES) }).strict(),
]);
export type RequestHeaderRule = z.infer<typeof headerRule>;

export const WHOLE_SEGMENT = /^\$\{([^}]+)\}$/;

export function isCallerExpression(name: string): boolean {
  return name.startsWith("caller.");
}

export function wholeValueExpression(value: unknown): string | null {
  const whole = typeof value === "string" ? WHOLE_SEGMENT.exec(value) : null;
  const name = whole?.[1];
  return name !== undefined && !isCallerExpression(name) && expression.safeParse(name).success
    ? name
    : null;
}

export function valueAllowed(
  variableRule: RequestVariableRule | undefined,
  value: string,
): boolean {
  if (!variableRule) return false;
  if ("enum" in variableRule) return variableRule.enum.includes(value);
  if ("caller_bound" in variableRule) return VALUE_CLASSES.uuid.test(value);
  if (variableRule.class === "path") return false;
  return VALUE_CLASSES[variableRule.class]?.test(value) === true;
}

export function pathValueAllowed(value: string): boolean {
  if (value.length > MAX_PATH_VALUE) return false;
  if (value.startsWith("//")) return false;
  if (!VALUE_CLASSES.path.test(value)) return false;
  return value.split("/").every((segment) => {
    if (segment === "." || segment === "..") return false;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return false;
    }
    return !decoded.includes("/") && decoded !== "." && decoded !== "..";
  });
}

export function ruleLabel(variableRule: RequestVariableRule | undefined): string {
  if (!variableRule) return "no rule";
  if ("enum" in variableRule) return `enum of ${variableRule.enum.length} value(s)`;
  if ("caller_bound" in variableRule) return "the authenticated caller";
  return `class ${variableRule.class}`;
}
