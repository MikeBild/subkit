import { pluralKey, type TranslationKey } from "@/lib/i18n";

export interface RequestBoundaryView {
  method: string;
  origin?: string;
  segments?: Array<string | { var: string }>;
  destination?: { var: string; hosts: string[] };
  variables: Record<
    string,
    { enum: string[] } | { class: string } | { caller_bound: true } | { created_by_workflow: true }
  >;
  query: { fixed: Record<string, string>; variable: Array<{ key: string; var: string }> };
  connector_query?: { fixed: Record<string, string>; credential: string[] };
  max_body_bytes: number;
  max_calls: number;
  pagination?: { params: string[]; max_requests: number; location?: "body" };
  destructive?: true;
}

interface RequestBoundaryPresentation {
  title: TranslationKey;
  destructive: boolean;
  target: string;
  variables: Array<{ key: TranslationKey; values: Record<string, string> }>;
  classNotice: boolean;
  body: { key: TranslationKey; values: Record<string, string | number> };
  calls: number;
  paging: { key: TranslationKey; values: Record<string, string | number> } | null;
  connectorQuery: { key: TranslationKey; values: Record<string, string> } | null;
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
  long_identifier: "authority.boundary.class.long_identifier",
  uuid: "authority.boundary.class.uuid",
  integer: "authority.boundary.class.integer",
  date: "authority.boundary.class.date",
  timestamp: "authority.boundary.class.timestamp",
  timestamp_range: "authority.boundary.class.timestamp_range",
  file_name: "authority.boundary.class.file_name",
  path: "authority.boundary.class.path",
};

export function presentRequestBoundary(
  boundary: RequestBoundaryView,
  formatNumber: (value: number) => string,
): RequestBoundaryPresentation {
  const connectorKeys = [
    ...Object.keys(boundary.connector_query?.fixed ?? {}),
    ...(boundary.connector_query?.credential ?? []),
  ];
  const query = [
    ...Object.entries(boundary.query.fixed).map(([key, value]) => `${key}=${value}`),
    ...boundary.query.variable.map((entry) => `${entry.key}={${entry.var}}`),
    ...connectorKeys.map((key) => `${key}=…`),
  ].join("&");
  let unknownRule = false;
  const destination = boundary.destination
    ? [
        {
          key: "authority.boundary.allowedHosts" as const,
          values: { name: boundary.destination.var, hosts: boundary.destination.hosts.join(", ") },
        },
      ]
    : [];
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
      if ("caller_bound" in entry)
        return { key: "authority.boundary.callerBound" as const, values: { name } };
      if ("created_by_workflow" in entry)
        return { key: "authority.boundary.createdByWorkflow" as const, values: { name } };
      const key = CLASS_KEYS[entry.class];
      if (key) return { key, values: { name } };
      unknownRule = true;
      return {
        key: "authority.boundary.unknownRule" as const,
        values: { name, rule: String(entry.class) },
      };
    },
  );
  const target = boundary.destination
    ? `{${boundary.destination.var}} → ${boundary.destination.hosts
        .map((host) => `https://${host}`)
        .join(", ")}`
    : `${boundary.origin ?? ""}${(boundary.segments ?? [])
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
        key: pluralKey(
          boundary.pagination.location === "body"
            ? "authority.boundary.bodyPaging"
            : "authority.boundary.paging",
          boundary.pagination.max_requests,
        ),
        values: {
          params: boundary.pagination.params.join(", "),
          count: boundary.pagination.max_requests,
        },
      }
    : null;
  const connectorQuery =
    connectorKeys.length > 0
      ? {
          key: pluralKey("authority.boundary.connectorQuery", connectorKeys.length),
          values: { names: connectorKeys.join(", ") },
        }
      : null;
  const shared = {
    target,
    variables: [...destination, ...variables],
    paging,
    connectorQuery,
    classNotice: Object.values(boundary.variables).some((entry) => "class" in entry),
    body,
    calls: boundary.max_calls,
    declaredDestructive: boundary.destructive === true && boundary.method !== "DELETE",
  };
  const declared = boundary.destructive === true || unknownRule;
  switch (boundary.method) {
    case "GET":
    case "HEAD":
      return {
        ...shared,
        title: boundary.destination ? "authority.boundary.readHosts" : "authority.boundary.read",
        destructive: declared,
      };
    case "POST":
    case "PUT":
    case "PATCH":
      return {
        ...shared,
        title: boundary.destination ? "authority.boundary.sendHosts" : "authority.boundary.send",
        destructive: declared,
      };
    case "DELETE":
      return { ...shared, title: "authority.boundary.delete", destructive: true };
    default:
      return { ...shared, title: "authority.boundary.unknown", destructive: true };
  }
}
