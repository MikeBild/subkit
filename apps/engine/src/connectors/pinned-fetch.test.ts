import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("the engine runtime dials the supplied IP and verifies the original TLS hostname", async () => {
  const folder = await mkdtemp(join(tmpdir(), "subkit-pinned-origin-"));
  try {
    const key = join(folder, "key.pem");
    const cert = join(folder, "cert.pem");
    const openssl = Bun.spawn(
      [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-subj",
        "/CN=origin.fixture.test",
        "-addext",
        "subjectAltName=DNS:origin.fixture.test",
        "-days",
        "1",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    expect(await openssl.exited).toBe(0);
    const script = join(folder, "probe.ts");
    const moduleUrl = pathToFileURL(join(import.meta.dir, "pinned-fetch.ts")).href;
    await writeFile(
      script,
      `
import { createServer } from "node:https";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";
import { fetchPinnedOrigin } from ${JSON.stringify(moduleUrl)};
let requests = 0;
const server = createServer({ key: readFileSync(${JSON.stringify(key)}), cert: readFileSync(${JSON.stringify(cert)}) }, (request, response) => {
  requests += 1;
  response.end(JSON.stringify({ host: request.headers.host, sni: (request.socket as TLSSocket).servername }));
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
try {
  const url = new URL(\`https://origin.fixture.test:\${port}/proof\`);
  if (process.env.SUBKIT_EXPECT_PROXY_BLOCK === "1") {
    let blocked = false;
    try { await fetchPinnedOrigin(url, { address: "127.0.0.1", family: 4 }, { signal: AbortSignal.timeout(3000) }, fetch); }
    catch (error) { blocked = (error as { reason?: string }).reason === "proxy_environment_unsupported"; }
    if (!blocked || requests !== 0) throw new Error("proxy configuration was not refused before dispatch");
  } else {
  const response = await fetchPinnedOrigin(url, { address: "127.0.0.1", family: 4 }, { signal: AbortSignal.timeout(3000) }, fetch);
  const observed = await response.json() as { host: string; sni: string };
  if (response.status !== 200 || observed.host !== url.host || observed.sni !== url.hostname || response.url !== url.href) throw new Error("origin identity changed");
  let refused = false;
  try { await fetchPinnedOrigin(new URL(\`https://wrong.fixture.test:\${port}/proof\`), { address: "127.0.0.1", family: 4 }, { signal: AbortSignal.timeout(3000) }, fetch); } catch { refused = true; }
  if (!refused || requests !== 1) throw new Error("TLS hostname verification failed");
  }
} finally {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
`,
    );
    for (const proxyCase of [false, true]) {
      const child = Bun.spawn([process.execPath, script], {
        env: {
          ...process.env,
          NODE_EXTRA_CA_CERTS: cert,
          HTTP_PROXY: "",
          http_proxy: "",
          ALL_PROXY: "",
          all_proxy: "",
          HTTPS_PROXY: proxyCase ? "http://127.0.0.1:1" : "",
          https_proxy: "",
          NO_PROXY: "",
          no_proxy: "",
          SUBKIT_EXPECT_PROXY_BLOCK: proxyCase ? "1" : "0",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(output[0]).toBe("");
      if (output[2] !== 0) throw new Error(`Pinned TLS child failed: ${output[1]}`);
      expect(output[2]).toBe(0);
    }
    expect(await readFile(cert, "utf8")).toContain("BEGIN CERTIFICATE");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}, 15000);
