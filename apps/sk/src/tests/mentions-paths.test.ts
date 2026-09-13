// Mentions HTTP-path regression test.
//
// Covers the audit finding that `@api-key`, `@user`, `@audit` entity
// mentions hit the wrong engine paths (`/v1/api-keys`, `/v1/users`,
// `/v1/audit-log/:id` — none of which exist). After Gap #P0 the paths
// are mapped through the real identity routes and the audit query
// endpoint.

import { describe, expect, it } from "bun:test";

import { resolveMentions } from "../mentions.ts";

interface RequestCall {
  method: string;
  path: string;
}

function makeClient(): {
  request: (method: string, path: string) => Promise<unknown>;
  calls: RequestCall[];
} {
  const calls: RequestCall[] = [];
  return {
    async request(method: string, path: string) {
      calls.push({ method, path });
      return { id: path };
    },
    calls,
  };
}

describe("mentions — entity HTTP paths", () => {
  it("@api-key:<id> hits /v1/identity/api-keys/:id", async () => {
    const client = makeClient();
    await resolveMentions("@api-key:00000000-0000-0000-0000-000000000001 tell me", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test stub
      client: client as any,
    });
    expect(client.calls[0]?.path).toBe(
      "/v1/identity/api-keys/00000000-0000-0000-0000-000000000001",
    );
  });

  it("@user:<id> hits /v1/identity/users/:id", async () => {
    const client = makeClient();
    await resolveMentions("@user:00000000-0000-0000-0000-000000000002", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test stub
      client: client as any,
    });
    expect(client.calls[0]?.path).toBe("/v1/identity/users/00000000-0000-0000-0000-000000000002");
  });

  it("@audit:<id> uses the query endpoint (no /v1/audit-log/:id)", async () => {
    const client = makeClient();
    await resolveMentions("@audit:00000000-0000-0000-0000-000000000003", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test stub
      client: client as any,
    });
    expect(client.calls[0]?.path).toBe("/v1/audit-log?id=00000000-0000-0000-0000-000000000003");
  });

  it("@workflow + @execution + @connector unchanged", async () => {
    const client = makeClient();
    await resolveMentions("@workflow:abc @execution:def @connector:ghi", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test stub
      client: client as any,
    });
    expect(client.calls.map((c) => c.path)).toEqual([
      "/v1/workflows/abc",
      "/v1/executions/def",
      "/v1/connectors/ghi",
    ]);
  });
});
