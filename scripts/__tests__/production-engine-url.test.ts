import { describe, expect, test } from "bun:test";
import {
  type Deployment,
  type ResolveOptions,
  reportedEngineUrl,
  resolveProductionEngineUrl,
} from "../production-engine-url.ts";

const REPOSITORY = "owner/deploy";
const API = `https://api.github.com/repos/${REPOSITORY}`;
const SINCE = new Date("2026-01-01T10:00:00Z");

type Route = { status: number; body: unknown };

function options(routes: Record<string, Route | Route[]>, overrides: Partial<ResolveOptions> = {}) {
  const calls: string[] = [];
  let clock = SINCE.getTime();
  const resolved: ResolveOptions = {
    token: "token",
    repository: REPOSITORY,
    since: SINCE,
    timeoutMs: 60_000,
    pollMs: 20_000,
    fetch: async (url) => {
      calls.push(url);
      const entry = routes[url];
      const route = Array.isArray(entry) ? (entry.length > 1 ? entry.shift() : entry[0]) : entry;
      if (!route) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(route.body), { status: route.status });
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    ...overrides,
  };
  return { calls, resolved };
}

function deployment(id: number, createdAt: string, statuses: Deployment["statuses"]): Deployment {
  return { id, created_at: createdAt, statuses };
}

describe("reported production engine url", () => {
  test("takes the newest successful https environment url of deployments since the request", () => {
    expect(
      reportedEngineUrl(
        [
          deployment(3, "2026-01-01T10:05:00Z", [
            {
              state: "failure",
              environment_url: "https://failed.example.com",
              created_at: "2026-01-01T10:09:00Z",
            },
            {
              state: "success",
              environment_url: "https://engine.example.com/",
              created_at: "2026-01-01T10:08:00Z",
            },
          ]),
          deployment(2, "2026-01-01T10:01:00Z", [
            {
              state: "success",
              environment_url: "https://older.example.com",
              created_at: "2026-01-01T10:02:00Z",
            },
          ]),
          deployment(1, "2026-01-01T09:00:00Z", [
            {
              state: "success",
              environment_url: "https://stale.example.com",
              created_at: "2026-01-01T11:00:00Z",
            },
          ]),
        ],
        SINCE,
      ),
    ).toBe("https://engine.example.com");
  });

  test("ignores empty, plain-http and pre-request urls", () => {
    expect(
      reportedEngineUrl(
        [
          deployment(2, "2026-01-01T10:01:00Z", [
            { state: "success", environment_url: "", created_at: "2026-01-01T10:02:00Z" },
            {
              state: "success",
              environment_url: "http://plain.example.com",
              created_at: "2026-01-01T10:03:00Z",
            },
          ]),
          deployment(1, "2026-01-01T09:00:00Z", [
            {
              state: "success",
              environment_url: "https://stale.example.com",
              created_at: "2026-01-01T09:05:00Z",
            },
          ]),
        ],
        SINCE,
      ),
    ).toBeNull();
  });
});

describe("resolving the production engine url", () => {
  const listUrl = `${API}/deployments?environment=production&per_page=20`;
  const statusesUrl = `${API}/deployments/7/statuses?per_page=20`;
  const listed = { status: 200, body: [{ id: 7, created_at: "2026-01-01T10:01:00Z" }] };

  test("returns the reported url once it answers as a SubKit engine", async () => {
    const { calls, resolved } = options({
      [listUrl]: listed,
      [statusesUrl]: [
        {
          status: 200,
          body: [{ state: "in_progress", environment_url: "", created_at: "2026-01-01T10:01:00Z" }],
        },
        {
          status: 200,
          body: [
            {
              state: "success",
              environment_url: "https://engine.example.com/",
              created_at: "2026-01-01T10:06:00Z",
            },
          ],
        },
      ],
      "https://engine.example.com/health": {
        status: 200,
        body: { status: "ok", service: "subkit" },
      },
    });
    expect(await resolveProductionEngineUrl(resolved)).toEqual({
      url: "https://engine.example.com",
    });
    expect(calls.filter((url) => url === statusesUrl)).toHaveLength(2);
  });

  test("skips with a reason when no token is configured", async () => {
    const { calls, resolved } = options({}, { token: undefined });
    expect(await resolveProductionEngineUrl(resolved)).toEqual({
      url: null,
      reason: "the deployment dispatch token is not configured",
    });
    expect(calls).toHaveLength(0);
  });

  test("skips with a reason when the token cannot read the deployments", async () => {
    const { resolved } = options({ [listUrl]: { status: 403, body: {} } });
    expect(await resolveProductionEngineUrl(resolved)).toEqual({
      url: null,
      reason: `the deployments of ${REPOSITORY} are not readable with the deployment dispatch token (HTTP 403)`,
    });
  });

  test("skips right away when the deployment finished without reporting a url", async () => {
    const { calls, resolved } = options({
      [listUrl]: listed,
      [statusesUrl]: {
        status: 200,
        body: [{ state: "success", environment_url: "", created_at: "2026-01-01T10:06:00Z" }],
      },
    });
    expect(await resolveProductionEngineUrl(resolved)).toEqual({
      url: null,
      reason: `the production deployment of ${REPOSITORY} finished without reporting an engine URL`,
    });
    expect(calls.filter((url) => url === listUrl)).toHaveLength(1);
  });

  test("skips with a reason when no deployment reports a url before the deadline", async () => {
    const { resolved } = options({
      [listUrl]: listed,
      [statusesUrl]: {
        status: 200,
        body: [{ state: "in_progress", environment_url: "", created_at: "2026-01-01T10:06:00Z" }],
      },
    });
    expect(await resolveProductionEngineUrl(resolved)).toEqual({
      url: null,
      reason: `no production deployment of ${REPOSITORY} reported an engine URL within 1 minutes`,
    });
  });

  test("refuses a reported url that is not a SubKit engine", async () => {
    const { resolved } = options({
      [listUrl]: listed,
      [statusesUrl]: {
        status: 200,
        body: [
          {
            state: "success",
            environment_url: "https://other.example.com",
            created_at: "2026-01-01T10:06:00Z",
          },
        ],
      },
      "https://other.example.com/health": { status: 200, body: { status: "ok", service: "other" } },
    });
    expect(await resolveProductionEngineUrl(resolved)).toEqual({
      url: null,
      reason: "the reported production URL does not answer as a SubKit engine",
    });
  });
});
