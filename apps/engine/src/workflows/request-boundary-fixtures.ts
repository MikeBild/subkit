import { RequestStepSchema } from "./types.ts";

const CONNECTOR = "00000000-0000-4000-8000-000000000001";

export const BASE = "https://api.example.test/v2";

export function step(extra: Record<string, unknown>) {
  return RequestStepSchema.parse({
    id: "call",
    kind: "request",
    connector_id: CONNECTOR,
    ...extra,
  });
}

export const ID = "3f2c1b9a-7d4e-4c1a-9b8e-2a6f0c5d1e77";

export const statsUrl = (id: string, query: string) =>
  `https://api.example.test/v2/sites/blog/stats/${id}?${query}`;

export const GOOD_QUERY = "from=2026-09-20T00%3A00%3A00.000Z&to=2026-09-21T00%3A00%3A00Z&tz=UTC";

export function requestBoundaryFixtures() {
  const release = step({
    method: "POST",
    path: "/sites/${input.site}/releases",
    headers: { "content-type": "application/json" },
    body: { reason: "retire ${scope.pick.data.count}", ids: "${scope.pick.data.ids}" },
    boundary: {
      variables: { "input.site": { enum: ["company-cockpit", "blog"] } },
      max_body_bytes: 200,
      max_calls: 1,
    },
  });

  const stats = step({
    method: "GET",
    path: "/sites/${input.site}/stats/${item.id}",
    query: { from: "${scope.window.data.start}", to: "${scope.window.data.end}", tz: "UTC" },
    boundary: {
      variables: {
        "input.site": { enum: ["blog"] },
        "item.id": { class: "uuid" },
        "scope.window.data.start": { class: "timestamp" },
        "scope.window.data.end": { class: "timestamp" },
      },
      max_body_bytes: 0,
      max_calls: 30,
    },
  });

  return { release, stats };
}
