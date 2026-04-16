import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;

beforeAll(async () => {
  suite = await startMcpTestSuite("resources");
});

afterAll(async () => {
  await suite.cleanup();
});

describe("mcp resources", () => {
  test("list + read connector resource", async () => {
    const { id } = await suite.seedConnector({
      slug: "res-probe",
      display_name: "Resource Probe",
      driver: "http",
      base_url: "https://api.probe.test",
    });
    const client = await suite.connect();
    const list = await client.listResources();
    const uris = list.resources.map((r) => r.uri);
    expect(uris).toContain(`connector://${id}`);

    const read = await client.readResource({ uri: `connector://${id}` });
    expect(read.contents.length).toBe(1);
    const content = read.contents[0] as { mimeType?: string; text?: string };
    expect(content.mimeType).toBe("application/json");
    const body = JSON.parse(content.text!) as {
      id: string;
      driver: string;
      base_url: string;
    };
    expect(body.id).toBe(id);
    expect(body.driver).toBe("http");
    expect(body.base_url).toBe("https://api.probe.test");
  });
});
