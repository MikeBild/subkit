import { pluralKey, type TranslationKey } from "@/lib/i18n";

export interface RequestBoundaryView {
  method: string;
  origin: string;
  segments: Array<string | { var: string }>;
  variables: Record<string, { enum: string[] } | { class: string }>;
  query: { fixed: Record<string, string>; variable: Array<{ key: string; var: string }> };
  max_body_bytes: number;
  max_calls: number;
  pagination?: { params: string[]; max_requests: number };
  destructive?: true;
}

export interface RequestBoundaryPresentation {
  title: TranslationKey;
  destructive: boolean;
  target: string;
  variables: Array<{ key: TranslationKey; values: Record<string, string> }>;
  classNotice: boolean;
  body: { key: TranslationKey; values: Record<string, string | number> };
  calls: number;
  paging: { key: TranslationKey; values: Record<string, string | number> } | null;
  declaredDestructive: boolean;
}

function readable(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export const CLASS_KEYS: Record<string, TranslationKey> = {
  identifier: "authority.boundary.class.identifier",
  uuid: "authority.boundary.class.uuid",
  integer: "authority.boundary.class.integer",
  date: "authority.boundary.class.date",
  timestamp: "authority.boundary.class.timestamp",
  file_name: "authority.boundary.class.file_name",
  path: "authority.boundary.class.path",
};

export function presentRequestBoundary(
  boundary: RequestBoundaryView,
  formatNumber: (value: number) => string,
): RequestBoundaryPresentation {
  const query = [
    ...Object.entries(boundary.query.fixed).map(([key, value]) => `${key}=${value}`),
    ...boundary.query.variable.map((entry) => `${entry.key}={${entry.var}}`),
  ].join("&");
  let unknownRule = false;
  const variables = Object.entries(boundary.variables).map(
    ([name, entry]): RequestBoundaryPresentation["variables"][number] => {
      if ("enum" in entry) {
        const values = entry.enum.join(", ");
        const decoded = entry.enum.some((value) => value.includes("%"))
          ? entry.enum.map(readable).join(", ")
          : null;
        return decoded === null
          ? { key: "authority.boundary.variable" as const, values: { name, values } }
          : {
              key: "authority.boundary.variableEncoded" as const,
              values: { name, values, decoded },
            };
      }
      const key = CLASS_KEYS[entry.class];
      if (key) return { key, values: { name } };
      unknownRule = true;
      return {
        key: "authority.boundary.unknownRule" as const,
        values: { name, rule: String(entry.class) },
      };
    },
  );
  const target = `${boundary.origin}${boundary.segments
    .map((part) => (typeof part === "string" ? part : `{${part.var}}`))
    .join("/")}${query ? `?${query}` : ""}`;
  const body: RequestBoundaryPresentation["body"] =
    boundary.max_body_bytes === 0
      ? { key: "authority.boundary.noBody", values: {} }
      : {
          key: "authority.boundary.bodyLimit",
          values: { bytes: formatNumber(boundary.max_body_bytes) },
        };
  const paging = boundary.pagination
    ? {
        key: pluralKey("authority.boundary.paging", boundary.pagination.max_requests),
        values: {
          params: boundary.pagination.params.join(", "),
          count: boundary.pagination.max_requests,
        },
      }
    : null;
  const shared = {
    target,
    variables,
    paging,
    classNotice: Object.values(boundary.variables).some((entry) => !("enum" in entry)),
    body,
    calls: boundary.max_calls,
    declaredDestructive: boundary.destructive === true && boundary.method !== "DELETE",
  };
  const declared = boundary.destructive === true || unknownRule;
  switch (boundary.method) {
    case "GET":
    case "HEAD":
      return { ...shared, title: "authority.boundary.read", destructive: declared };
    case "POST":
    case "PUT":
    case "PATCH":
      return { ...shared, title: "authority.boundary.send", destructive: declared };
    case "DELETE":
      return { ...shared, title: "authority.boundary.delete", destructive: true };
    default:
      return { ...shared, title: "authority.boundary.unknown", destructive: true };
  }
}
