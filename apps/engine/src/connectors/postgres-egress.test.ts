import { expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { testEnv } from "../test-helpers/determinism/env.ts";
import { flush } from "../test-helpers/determinism/wait.ts";
import { _withEgressLookupForTests } from "./egress-guard.ts";
import { postgresPoolConfiguration } from "./postgres-egress.ts";

const host = "database.public.example.test";
const publicAddress = "93.184.216.34";

test("strict DSN parsing rejects encoded, duplicate and mixed-case local SSL files before pg parses them", async () => {
  for (const parameter of [
    "sslkey=/missing/private",
    "%73slcert=/missing/cert",
    "SSLROOTCERT=/missing/ca",
    "sslkey=&sslkey=/missing/private",
  ]) {
    await expect(
      postgresPoolConfiguration(`postgresql://user@${host}/db?${parameter}`, { mode: "strict" }),
    ).rejects.toThrow("postgres_local_ssl_file_blocked");
  }
  for (const mode of ["disable", "no-verify", "require", "verify-ca"]) {
    const prepared = await postgresPoolConfiguration(
      `postgresql://user:secret@${host}/db?sslmode=${mode}&uselibpqcompat=true`,
      { mode: "strict" },
    );
    expect(prepared.options.connectionString).toBeUndefined();
    expect(prepared.options.host).toBe(host);
    expect(prepared.options.password).toBe("secret");
    expect(prepared.options.ssl).toMatchObject({ rejectUnauthorized: true });
    expect(
      typeof (prepared.options.ssl as { checkServerIdentity?: unknown }).checkServerIdentity,
    ).toBe("function");
  }
  const permissive = await postgresPoolConfiguration(
    `postgresql://user@${host}/db?sslmode=no-verify`,
    { mode: "permissive" },
  );
  expect(permissive.options.connectionString).toContain("sslmode=no-verify");
  expect(permissive.options.stream).toBeUndefined();
});

async function tlsFixture(supportsTls = true) {
  const directory = mkdtempSync(join(tmpdir(), "subkit-pg-tls-"));
  const keyPath = join(directory, "key.pem");
  const certPath = join(directory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      `/CN=${host}`,
      "-addext",
      `subjectAltName=DNS:${host}`,
    ],
    { stdio: "ignore" },
  );
  const cert = readFileSync(certPath);
  const names: string[] = [];
  let startupCount = 0;
  const server = spawn(
    "node",
    [
      "-e",
      `
    const net = require('node:net');
    const tls = require('node:tls');
    const fs = require('node:fs');
    const context = tls.createSecureContext({ cert: fs.readFileSync(process.argv[1]), key: fs.readFileSync(process.argv[2]) });
    const server = net.createServer(socket => {
      socket.on('error', () => {});
      socket.once('data', request => {
        if (!request.equals(Buffer.from([0,0,0,8,4,210,22,47]))) return socket.destroy();
        if (${!supportsTls}) return socket.end('N');
        socket.write('S');
        const secured = new tls.TLSSocket(socket, { isServer: true, secureContext: context });
        secured.on('error', () => {});
        secured.once('secure', () => console.log(JSON.stringify({ servername: secured.servername })));
        secured.once('data', () => {
          console.log(JSON.stringify({ startup: true }));
          secured.write(Buffer.from([82,0,0,0,8,0,0,0,0,90,0,0,0,5,73]));
        });
      });
    });
    server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port })));
  `,
      certPath,
      keyPath,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let buffer = "";
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.once("exit", () => reject(new Error("TLS fixture stopped")));
    server.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const value = JSON.parse(buffer.slice(0, newline)) as {
          port?: number;
          servername?: string;
          startup?: boolean;
        };
        buffer = buffer.slice(newline + 1);
        if (value.port) resolve(value.port);
        if (value.servername) names.push(value.servername);
        if (value.startup) startupCount += 1;
        newline = buffer.indexOf("\n");
      }
    });
  });
  return {
    cert,
    port,
    names,
    get startupCount() {
      return startupCount;
    },
    async close() {
      const stopped = new Promise<void>((resolve) => server.once("exit", () => resolve()));
      server.kill();
      await stopped;
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function withRedirectedDial<T>(port: number, operation: (dials: string[]) => Promise<T>) {
  const original = net.Socket.prototype.connect;
  const dials: string[] = [];
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const options = args[0] as { host?: string; port?: number; family?: number };
    if (typeof options === "object" && options.host === publicAddress) {
      dials.push(options.host);
      return Reflect.apply(original, this, [{ ...options, host: "127.0.0.1", port }]);
    }
    return Reflect.apply(original, this, args);
  } as typeof original;
  try {
    return await operation(dials);
  } finally {
    net.Socket.prototype.connect = original;
  }
}

test("Bun pg TLS connects to the approved literal while preserving original SNI and hostname verification", async () => {
  const server = await tlsFixture();
  try {
    await _withEgressLookupForTests(
      async () => [{ address: publicAddress, family: 4 }],
      () =>
        withRedirectedDial(server.port, async (dials) => {
          const prepared = await postgresPoolConfiguration(
            `postgresql://user:secret@${host}:${server.port}/db?sslmode=no-verify`,
            { mode: "strict" },
            { connectionTimeoutMillis: 2000 },
          );
          prepared.options.ssl = { ...(prepared.options.ssl as object), ca: server.cert };
          const client = new pg.Client(prepared.options);
          try {
            await client.connect();
          } finally {
            await client.end();
          }
          expect(dials).toEqual([publicAddress]);
          expect(server.names).toEqual([host]);
          expect(server.startupCount).toBe(1);
          const wrong = await postgresPoolConfiguration(
            `postgresql://user:secret@wrong.public.example.test:${server.port}/db?sslmode=disable`,
            { mode: "strict" },
            { connectionTimeoutMillis: 2000 },
          );
          wrong.options.ssl = { ...(wrong.options.ssl as object), ca: server.cert };
          const rejected = new pg.Client(wrong.options);
          try {
            await expect(rejected.connect()).rejects.toThrow();
          } finally {
            await rejected.end();
          }
          expect(server.startupCount).toBe(1);
        }),
    );
  } finally {
    await server.close();
  }
});

test("every physical pg connection resolves all DNS records and never dials a rebinding address", async () => {
  let reads = 0;
  const prepared = await postgresPoolConfiguration(
    `postgresql://user:secret@${host}/db`,
    { mode: "strict" },
    { connectionTimeoutMillis: 1000 },
  );
  await _withEgressLookupForTests(
    async () => {
      reads += 1;
      return [
        { address: publicAddress, family: 4 },
        { address: "127.0.0.1", family: 4 },
      ];
    },
    async () => {
      await withRedirectedDial(1, async (dials) => {
        for (let i = 0; i < 2; i += 1) {
          const client = new pg.Client(prepared.options);
          try {
            await expect(client.connect()).rejects.toThrow("private_ip_resolved");
          } finally {
            await client.end();
          }
        }
        expect(dials).toHaveLength(0);
      });
    },
  );
  expect(reads).toBe(2);
});

test("a timed-out pg connection cannot dial after its delayed DNS validation finishes", async () => {
  let release: (() => void) | undefined;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prepared = await postgresPoolConfiguration(
    `postgresql://user:secret@${host}/db`,
    { mode: "strict" },
    { connectionTimeoutMillis: 20 },
  );
  await _withEgressLookupForTests(
    async () => {
      await delayed;
      return [{ address: publicAddress, family: 4 }];
    },
    () =>
      withRedirectedDial(1, async (dials) => {
        const client = new pg.Client(prepared.options);
        try {
          await expect(client.connect()).rejects.toThrow("timeout");
        } finally {
          await client.end();
        }
        release?.();
        await flush();
        expect(dials).toHaveLength(0);
      }),
  );
});

test("strict PG credentials never inherit process PG defaults or pgpass fallback", async () => {
  const previous = Object.fromEntries(
    ["PGPASSWORD", "PGUSER", "PGDATABASE", "PGPORT"].map((name) => [name, testEnv[name]]),
  );
  try {
    testEnv.PGPASSWORD = "synthetic-process-secret";
    testEnv.PGUSER = "synthetic-process-user";
    testEnv.PGDATABASE = "synthetic-process-db";
    testEnv.PGPORT = "12345";
    const prepared = await postgresPoolConfiguration(`postgresql://tenant-user@${host}`, {
      mode: "strict",
    });
    expect(prepared.options.user).toBe("tenant-user");
    expect(prepared.options.database).toBe("tenant-user");
    expect(prepared.options.port).toBe(5432);
    expect(typeof prepared.options.password).toBe("function");
    expect(await (prepared.options.password as () => string)()).toBe("");
    await expect(
      postgresPoolConfiguration(`postgresql://${host}/db`, { mode: "strict" }),
    ).rejects.toThrow("postgres_explicit_target_required");
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete testEnv[name];
      else testEnv[name] = value;
    }
  }
});

test("strict PG refuses a cleartext-only server before any startup or credential message", async () => {
  const server = await tlsFixture(false);
  try {
    await _withEgressLookupForTests(
      async () => [{ address: publicAddress, family: 4 }],
      () =>
        withRedirectedDial(server.port, async (dials) => {
          const prepared = await postgresPoolConfiguration(
            `postgresql://user:secret@${host}:${server.port}/db?sslmode=disable`,
            { mode: "strict" },
            { connectionTimeoutMillis: 1000 },
          );
          const client = new pg.Client(prepared.options);
          try {
            await expect(client.connect()).rejects.toThrow("does not support SSL");
          } finally {
            await client.end();
          }
          expect(server.startupCount).toBe(0);
          expect(dials).toEqual([publicAddress]);
        }),
    );
  } finally {
    await server.close();
  }
});
