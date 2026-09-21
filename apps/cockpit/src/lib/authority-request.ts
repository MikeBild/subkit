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

import type { TranslationKey } from "@/lib/i18n";

export interface RequestBoundaryView {
  method: string;
  origin: string;
  segments: Array<string | { var: string }>;
  variables: Record<string, { enum: string[] }>;
  query: { fixed: Record<string, string>; variable: string[] };
  max_body_bytes: number;
  max_calls: number;
  destructive?: true;
}

export interface RequestBoundaryPresentation {
  title: TranslationKey;
  destructive: boolean;
  /** The resolved target with each variable shown by name. */
  target: string;
  /** One line per variable: its name and every value it may take. */
  variables: Array<{ name: string; values: string }>;
  body: { key: TranslationKey; values: Record<string, string | number> };
  calls: number;
}

export function presentRequestBoundary(
  boundary: RequestBoundaryView,
  formatNumber: (value: number) => string,
): RequestBoundaryPresentation {
  const query = Object.entries(boundary.query.fixed)
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
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
    variables: Object.entries(boundary.variables).map(([name, rule]) => ({
      name,
      values: rule.enum.join(", "),
    })),
    body,
    calls: boundary.max_calls,
  };
  switch (boundary.method) {
    case "GET":
    case "HEAD":
      return { ...shared, title: "authority.boundary.read", destructive: false };
    case "POST":
    case "PUT":
    case "PATCH":
      return { ...shared, title: "authority.boundary.send", destructive: false };
    case "DELETE":
      return { ...shared, title: "authority.boundary.delete", destructive: true };
    default:
      return { ...shared, title: "authority.boundary.unknown", destructive: true };
  }
}
