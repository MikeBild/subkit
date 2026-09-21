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

const CLASS_KEYS: Record<string, TranslationKey> = {
  identifier: "authority.boundary.class.identifier",
  uuid: "authority.boundary.class.uuid",
  integer: "authority.boundary.class.integer",
  date: "authority.boundary.class.date",
  timestamp: "authority.boundary.class.timestamp",
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
  const shared = {
    target,
    variables,
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
