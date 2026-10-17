import { afterAll, expect, test } from "bun:test";
import { connect } from "node:net";
import { Hono } from "hono";

const app = new Hono();
app.get("*", (c) => c.json({ query: c.req.query(), values: c.req.queries("scope") }));
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });

afterAll(() => server.stop(true));

async function rawRequest(target: string): Promise<string> {
  const port = server.port;
  if (port === undefined) throw new Error("HTTP fixture has no TCP port");
  return new Promise((resolve, reject) => {
    let response = "";
    const socket = connect({ host: "127.0.0.1", port, signal: AbortSignal.timeout(5000) }, () => {
      socket.write(
        `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      response += chunk.toString();
    });
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
}

for (const fixture of [
  { target: "/probe?scope=visible", query: { scope: "visible" }, values: ["visible"] },
  { target: "/probe#?scope=hidden", query: {}, values: undefined },
  {
    target: "/probe?scope=visible#&scope=hidden",
    query: { scope: "visible" },
    values: ["visible"],
  },
  {
    target: "/probe?scope=visible%23literal",
    query: { scope: "visible#literal" },
    values: ["visible#literal"],
  },
]) {
  test(`HTTP query parsing respects URL boundaries for ${fixture.target}`, async () => {
    const response = await rawRequest(fixture.target);
    expect(response.startsWith("HTTP/1.1 200 ")).toBe(true);
    const body = JSON.parse(response.slice(response.indexOf("\r\n\r\n") + 4));
    expect(body.query).toEqual(fixture.query);
    expect(body.values).toEqual(fixture.values);
  });
}
