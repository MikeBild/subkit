// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal `${...}` placeholder tokens are part of the tested grammar.
// User story: As a workflow author, I want a loop body that calls an HTTP
// endpoint with the current item's id in the path to actually substitute
// that id at request time, so my "list X then fetch each X's resources"
// workflow returns one set of resources per X.
//
// Acceptance criteria:
//   - AC1: A request step inside a loop body whose `path` contains
//          `${item.id}` is dispatched with the resolved id, not the
//          literal placeholder. (The "session bc745e38" regression
//          where DigitalOcean returned 404 because the engine sent
//          `/v2/projects/$%7Bproject.id%7D/resources` over the wire.)
//   - AC2: The recorded outbound URL never contains `%24%7B` (URL-encoded
//          `${`) — proof the placeholder was substituted before the HTTP
//          driver ran.
//   - AC3: When a loop-body request references an undefined item key
//          (`${item.does_not_exist}`), the step fails fast with a
//          structured `placeholder_unresolved` error instead of shipping
//          the literal token over the wire.
// Spec refs: workflow-authoring.md "Loops" section,
//            docs/authoring.md placeholder substitution.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;
let mockApi: Server;
let mockBase = "";
let connectorId = "";

const RECEIVED_PATHS: string[] = [];

beforeAll(async () => {
  ctx = await createJourneyCtx("loop-request-placeholder");

  mockApi = createServer((req, res) => {
    const url = req.url ?? "/";
    RECEIVED_PATHS.push(url);
    res.setHeader("content-type", "application/json");
    if (url === "/v2/projects") {
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          projects: [
            { id: "proj-a", name: "Alpha" },
            { id: "proj-b", name: "Beta" },
          ],
        }),
      );
      return;
    }
    const m = /^\/v2\/projects\/([^/]+)\/resources$/.exec(url);
    if (m) {
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          resources: [{ urn: `do:droplet:${m[1]}-1` }],
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => mockApi.listen(0, "127.0.0.1", () => resolve()));
  const addr = mockApi.address() as AddressInfo;
  mockBase = `http://127.0.0.1:${addr.port}`;

  // Seed a connector pointing at the mock server so workflow steps can
  // route via `connector_id` exactly the way real authored workflows do.
  const createRes = await journeyFetch(ctx, "/v1/connectors", {
    method: "POST",
    body: JSON.stringify({
      name: "MockCloud",
      slug: "mockcloud",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: mockBase,
    }),
  });
  if (createRes.status !== 201) {
    throw new Error(`connector seed failed: HTTP ${createRes.status}`);
  }
  const connector = (await createRes.json()) as { id: string };
  connectorId = connector.id;
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  await new Promise<void>((resolve) => mockApi.close(() => resolve()));
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("54: Loop body + request step + ${item.id} placeholder", () => {
  test("AC1+AC2: ${item.id} resolves per iteration; URLs hit the wire as plain ids", async () => {
    // Reset the receive log so this test owns its assertions.
    RECEIVED_PATHS.length = 0;

    const createRes = await journeyFetch(ctx, "/v1/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "loop-fetch-resources",
        slug: "loop-fetch-resources",
        steps: [
          {
            id: "fetch_projects",
            kind: "request",
            method: "GET",
            connector_id: connectorId,
            path: "/v2/projects",
          },
          {
            id: "fetch_resources",
            kind: "loop",
            over: "fetch_projects.data.projects",
            body: ["get_project_resources"],
          },
          {
            id: "get_project_resources",
            kind: "request",
            method: "GET",
            connector_id: connectorId,
            // The bug: before the fix this literal text reached the wire
            // as `/v2/projects/$%7Bitem.id%7D/resources` and the API
            // returned 404. After the fix it must resolve per-iteration
            // to `/v2/projects/proj-a/resources` etc.
            path: "/v2/projects/${item.id}/resources",
          },
        ],
      }),
    });
    expect(createRes.status).toBe(201);
    const wf = (await createRes.json()) as { id: string };

    const runRes = await journeyFetch(ctx, "/v1/executions", {
      method: "POST",
      body: JSON.stringify({ source: "saved", workflow_id: wf.id, input: {} }),
    });
    expect(runRes.status).toBe(200);
    const runBody = (await runRes.json()) as { status: string };
    expect(runBody.status).toBe("succeeded");

    // The mock server saw exactly the resolved URLs — never the literal token.
    expect(RECEIVED_PATHS).toContain("/v2/projects");
    expect(RECEIVED_PATHS).toContain("/v2/projects/proj-a/resources");
    expect(RECEIVED_PATHS).toContain("/v2/projects/proj-b/resources");
    for (const p of RECEIVED_PATHS) {
      expect(p).not.toContain("%24%7B"); // URL-encoded `${`
      expect(p).not.toContain("${item");
    }
  });

  test("AC3: undefined ${item.…} key fails with placeholder_unresolved (no wire call)", async () => {
    RECEIVED_PATHS.length = 0;

    const createRes = await journeyFetch(ctx, "/v1/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "loop-bad-placeholder",
        slug: "loop-bad-placeholder",
        steps: [
          {
            id: "fetch_projects",
            kind: "request",
            method: "GET",
            connector_id: connectorId,
            path: "/v2/projects",
          },
          {
            id: "loop_step",
            kind: "loop",
            over: "fetch_projects.data.projects",
            body: ["bad_inner"],
          },
          {
            id: "bad_inner",
            kind: "request",
            method: "GET",
            connector_id: connectorId,
            path: "/v2/projects/${item.does_not_exist}/resources",
          },
        ],
      }),
    });
    expect(createRes.status).toBe(201);
    const wf = (await createRes.json()) as { id: string };

    const runRes = await journeyFetch(ctx, "/v1/executions", {
      method: "POST",
      body: JSON.stringify({ source: "saved", workflow_id: wf.id, input: {} }),
    });
    expect(runRes.status).toBe(200);
    const runBody = (await runRes.json()) as {
      status: string;
      steps: Array<{ step_key: string; status: string; error?: { code?: string } | null }>;
      output?: unknown;
    };

    // Loop bodies that fail don't fail the overall workflow today —
    // the loop wraps per-iteration failures in its envelope. What
    // matters is the inner body step row records a structured
    // placeholder_unresolved error so diagnose_run / the LLM can see
    // exactly what was wrong.
    //
    // The loop records step_key as `${bodyStep.id}[${itemIdx}]`, but
    // the surfaced steps array might either expose those rows directly
    // or hand back the loop's iteration envelope. Check the inner
    // step row first; fall back to the loop's per-iteration envelope.
    const failedInner = runBody.steps.find(
      (s) => s.step_key.startsWith("bad_inner") && s.status === "failed",
    );
    if (failedInner) {
      expect(failedInner.error?.code).toBe("placeholder_unresolved");
    } else {
      const iterations = (runBody.output ?? []) as Array<
        Record<string, { data?: unknown; error?: { code?: string } | null }>
      >;
      const innerErrors = iterations
        .map((iter) => iter?.bad_inner?.error?.code)
        .filter((c): c is string => typeof c === "string");
      expect(innerErrors.length).toBeGreaterThan(0);
      expect(innerErrors[0]).toBe("placeholder_unresolved");
    }

    // Never reached the wire for the bad inner step.
    for (const p of RECEIVED_PATHS) {
      expect(p).not.toContain("does_not_exist");
      expect(p).not.toContain("%24%7B");
    }
  });
});
