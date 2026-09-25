// How an author-declared request boundary is described to the person approving it.
//
// Same rule as the storage panel (`authority-storage.ts`), learned the hard way:
// there is no "everything else is harmless" branch. A removal was once shown to
// its approver as a read because the mapping fell through. Every method is named
// here, and one this table does not know is presented as unknown and
// destructive-styled rather than given a reassuring label.
//
// The panel also has to be honest about what the boundary is NOT. It limits
// where a request goes and how large it is. It does not limit what the request
// says — which records a release retires, what a page contains — and the
// per-run call ceiling is a reviewed number the system does not count yet.
//
// A variable is bound either by a list of values or by a value CLASS. A class
// approves every value of that form, so it gets its own plain sentence and a
// notice; a rule this table does not know makes the whole panel cautious.

import type { TranslationKey } from "@/lib/i18n";

export interface RequestBoundaryView {
  method: string;
  origin: string;
  segments: Array<string | { var: string }>;
  // `class` is a plain string on purpose: the unknown branch has to be reachable.
  variables: Record<string, { enum: string[] } | { class: string }>;
  query: { fixed: Record<string, string>; variable: Array<{ key: string; var: string }> };
  max_body_bytes: number;
  max_calls: number;
  /** Query keys the ENGINE fills while following the provider's paging. */
  pagination?: { params: string[]; max_requests: number };
  destructive?: true;
}

export interface RequestBoundaryPresentation {
  title: TranslationKey;
  destructive: boolean;
  /** The resolved target with each variable shown by name. */
  target: string;
  /** One line per variable: every value it may take, or the form a class allows. */
  variables: Array<{ key: TranslationKey; values: Record<string, string> }>;
  /** True when any variable is bound by form only. */
  classNotice: boolean;
  body: { key: TranslationKey; values: Record<string, string | number> };
  calls: number;
  /** Present when the engine itself sends follow-up requests to read the rest. */
  paging: { key: TranslationKey; values: Record<string, string | number> } | null;
  /** The author marked a request that is not a DELETE as removing or irreversible. */
  declaredDestructive: boolean;
}

function readable(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Every class the engine accepts needs a sentence here, or the panel calls it a
// rule it cannot describe and refuses the whole approval — correctly, but the
// author is then stuck with a boundary the engine took and the dialog will not
// explain. That happened in production: `file_name` shipped in the engine, this
// table did not learn it, and a repaired workflow could not be approved at all.
// `authority-request.classes.test.ts` holds this table against the engine's.
export const CLASS_KEYS: Record<string, TranslationKey> = {
  identifier: "authority.boundary.class.identifier",
  uuid: "authority.boundary.class.uuid",
  integer: "authority.boundary.class.integer",
  date: "authority.boundary.class.date",
  timestamp: "authority.boundary.class.timestamp",
  file_name: "authority.boundary.class.file_name",
  // The whole path, not one segment of it. It gets its own sentence rather than
  // the `unknownRule` fallback for the reason that fallback exists: a class the
  // engine accepts and this dialog cannot describe makes the workflow
  // unapprovable — which is exactly how `file_name` stranded a repaired
  // production workflow.
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
        // A percent-escaped value is what gets sent, but not what a person reads.
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
  // A paginated read makes more than one request, and which keys move is the
  // difference between "the same request again" and "something else". Saying
  // the number here is what makes the count reviewable at all.
  const paging = boundary.pagination
    ? {
        key: "authority.boundary.paging" as const,
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
  // An author's `destructive: true` can only make the panel more cautious, and
  // so can a rule this dialog cannot describe.
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
