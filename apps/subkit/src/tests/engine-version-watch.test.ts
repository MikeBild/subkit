import { afterEach, describe, expect, test } from "bun:test";
import { EngineClient, type FetchLike } from "../engine-client.ts";
import { watchEngineVersion } from "../engine-version-watch.ts";

afterEach(() => watchEngineVersion(null));

function clientAnswering(version: string | null): EngineClient {
  const fetchImpl: FetchLike = async () =>
    Response.json({ status: "ok" }, { headers: version ? { "x-subkit-version": version } : {} });
  return new EngineClient({ engine_url: "https://engine.test", api_key: "k", fetchImpl });
}

describe("engine version watch", () => {
  test("reports the engine version once per process", async () => {
    const seen: string[] = [];
    watchEngineVersion((version) => seen.push(version));
    const client = clientAnswering("12.1.0");
    await client.request("GET", "/health");
    await client.request("GET", "/health");
    expect(seen).toEqual(["12.1.0"]);
  });

  test("stays silent without a listener or without the header", async () => {
    await clientAnswering("12.1.0").request("GET", "/health");
    const seen: string[] = [];
    watchEngineVersion((version) => seen.push(version));
    await clientAnswering(null).request("GET", "/health");
    expect(seen).toEqual([]);
  });

  test("names the CLI and its version in the user agent", async () => {
    let agent = "";
    const fetchImpl: FetchLike = async (_input, init) => {
      agent = new Headers(init?.headers).get("user-agent") ?? "";
      return Response.json({});
    };
    await new EngineClient({ engine_url: "https://e.test", api_key: "k", fetchImpl }).request(
      "GET",
      "/health",
    );
    expect(agent).toMatch(/^subkit-cli\/\d+\.\d+\.\d+/);
  });
});
