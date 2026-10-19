import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  __resetOAuth2CacheForTests,
  DynamicRegistrationError,
  dynamicallyRegisterClient,
} from "../client.ts";

interface MockIdPOptions {
  registerStatus?: number;
  registerBody?: unknown;
  advertiseRegistrationEndpoint?: boolean;
  registerNonJson?: boolean;
}

async function readBody(req: IncomingMessage): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

interface MockIdP {
  baseUrl: string;
  close: () => Promise<void>;
  registrationCallCount: () => number;
}

async function startMockIdP(opts: MockIdPOptions = {}): Promise<MockIdP> {
  const {
    registerStatus = 201,
    registerBody,
    advertiseRegistrationEndpoint = true,
    registerNonJson = false,
  } = opts;

  let calls = 0;

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (
      url.pathname === "/.well-known/openid-configuration" ||
      url.pathname === "/.well-known/oauth-authorization-server"
    ) {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const discovery: Record<string, unknown> = {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
      };
      if (advertiseRegistrationEndpoint) {
        discovery.registration_endpoint = `${base}/register`;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(discovery));
      return;
    }

    if (url.pathname === "/register" && req.method === "POST") {
      calls += 1;
      await readBody(req);
      res.statusCode = registerStatus;
      if (registerNonJson) {
        res.setHeader("content-type", "text/plain");
        res.end("not valid json");
        return;
      }
      res.setHeader("content-type", "application/json");
      const body = registerBody ?? {
        client_id: "dyn-client-id",
        client_secret: "dyn-secret",
        client_id_issued_at: Math.floor(Date.now() / 1000), // allow-wall-clock: mock IdP issued_at field
        client_secret_expires_at: 0,
      };
      res.end(JSON.stringify(body));
      return;
    }

    res.statusCode = 404;
    res.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    registrationCallCount: () => calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let idp: MockIdP;

beforeAll(() => {
  __resetOAuth2CacheForTests();
});

afterEach(() => {
  __resetOAuth2CacheForTests();
});

afterAll(async () => {
  await idp?.close();
});

describe("dynamicallyRegisterClient — happy path", () => {
  test("returns clientId and clientSecret from 201 response", async () => {
    idp = await startMockIdP();
    const result = await dynamicallyRegisterClient(
      {
        issuerUrl: idp.baseUrl,
        clientMetadata: { redirect_uris: ["https://example.com/callback"] },
        allowInsecureRequests: true,
      },
      { mode: "permissive" },
    );
    expect(result.clientId).toBe("dyn-client-id");
    expect(result.clientSecret).toBe("dyn-secret");
    expect(result.registrationEndpoint).toContain("/register");
    expect(idp.registrationCallCount()).toBe(1);
    await idp.close();
  });

  test("client_secret is optional in the response (public clients)", async () => {
    idp = await startMockIdP({
      registerBody: { client_id: "public-client" },
    });
    const result = await dynamicallyRegisterClient(
      {
        issuerUrl: idp.baseUrl,
        clientMetadata: { redirect_uris: ["https://example.com/callback"] },
        allowInsecureRequests: true,
      },
      { mode: "permissive" },
    );
    expect(result.clientId).toBe("public-client");
    expect(result.clientSecret).toBeUndefined();
    await idp.close();
  });
});

describe("dynamicallyRegisterClient — validation before network call", () => {
  test("rejects empty redirect_uris before any network call", async () => {
    idp = await startMockIdP();
    await expect(
      dynamicallyRegisterClient(
        {
          issuerUrl: idp.baseUrl,
          clientMetadata: { redirect_uris: [] },
          allowInsecureRequests: true,
        },
        { mode: "permissive" },
      ),
    ).rejects.toThrow();
    expect(idp.registrationCallCount()).toBe(0);
    await idp.close();
  });

  test("rejects missing redirect_uris before any network call", async () => {
    idp = await startMockIdP();
    await expect(
      dynamicallyRegisterClient(
        {
          issuerUrl: idp.baseUrl,
          // @ts-expect-error intentionally invalid
          clientMetadata: {},
          allowInsecureRequests: true,
        },
        { mode: "permissive" },
      ),
    ).rejects.toThrow();
    expect(idp.registrationCallCount()).toBe(0);
    await idp.close();
  });
});

describe("dynamicallyRegisterClient — discovery failures", () => {
  test("throws DynamicRegistrationError when registration_endpoint is absent", async () => {
    idp = await startMockIdP({ advertiseRegistrationEndpoint: false });
    const err = await dynamicallyRegisterClient(
      {
        issuerUrl: idp.baseUrl,
        clientMetadata: { redirect_uris: ["https://example.com/callback"] },
        allowInsecureRequests: true,
      },
      { mode: "permissive" },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(DynamicRegistrationError);
    expect((err as DynamicRegistrationError).error_code).toBe("no_registration_endpoint");
    expect(idp.registrationCallCount()).toBe(0);
    await idp.close();
  });

  test("throws DynamicRegistrationError with discovery_failed when issuer unreachable", async () => {
    const err = await dynamicallyRegisterClient(
      {
        issuerUrl: "http://127.0.0.1:1",
        clientMetadata: { redirect_uris: ["https://example.com/callback"] },
        allowInsecureRequests: true,
      },
      { mode: "permissive" },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(DynamicRegistrationError);
    expect((err as DynamicRegistrationError).error_code).toBe("discovery_failed");
  });
});

describe("dynamicallyRegisterClient — registration POST failures", () => {
  test("throws DynamicRegistrationError with http_400 error_code on 400", async () => {
    idp = await startMockIdP({
      registerStatus: 400,
      registerBody: { error: "invalid_redirect_uri" },
    });
    const err = await dynamicallyRegisterClient(
      {
        issuerUrl: idp.baseUrl,
        clientMetadata: { redirect_uris: ["https://example.com/callback"] },
        allowInsecureRequests: true,
      },
      { mode: "permissive" },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(DynamicRegistrationError);
    expect((err as DynamicRegistrationError).error_code).toBe("registration_http_400");
    await idp.close();
  });

  test("throws DynamicRegistrationError with http_401 error_code on 401", async () => {
    idp = await startMockIdP({ registerStatus: 401, registerBody: { error: "unauthorized" } });
    const err = await dynamicallyRegisterClient(
      {
        issuerUrl: idp.baseUrl,
        clientMetadata: { redirect_uris: ["https://example.com/callback"] },
        allowInsecureRequests: true,
      },
      { mode: "permissive" },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(DynamicRegistrationError);
    expect((err as DynamicRegistrationError).error_code).toBe("registration_http_401");
    await idp.close();
  });

  test("throws DynamicRegistrationError with http_500 error_code on 500", async () => {
    idp = await startMockIdP({ registerStatus: 500, registerBody: { error: "server_error" } });
    const err = await dynamicallyRegisterClient(
      {
        issuerUrl: idp.baseUrl,
        clientMetadata: { redirect_uris: ["https://example.com/callback"] },
        allowInsecureRequests: true,
      },
      { mode: "permissive" },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(DynamicRegistrationError);
    expect((err as DynamicRegistrationError).error_code).toBe("registration_http_500");
    await idp.close();
  });

  test("throws DynamicRegistrationError when response body is non-JSON", async () => {
    idp = await startMockIdP({ registerNonJson: true });
    const err = await dynamicallyRegisterClient(
      {
        issuerUrl: idp.baseUrl,
        clientMetadata: { redirect_uris: ["https://example.com/callback"] },
        allowInsecureRequests: true,
      },
      { mode: "permissive" },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(DynamicRegistrationError);
    expect((err as DynamicRegistrationError).error_code).toBe("registration_response_invalid");
    await idp.close();
  });

  test("throws DynamicRegistrationError when response fails RFC7591 schema (missing client_id)", async () => {
    idp = await startMockIdP({
      registerBody: { client_secret: "secret-only-no-id" },
    });
    const err = await dynamicallyRegisterClient(
      {
        issuerUrl: idp.baseUrl,
        clientMetadata: { redirect_uris: ["https://example.com/callback"] },
        allowInsecureRequests: true,
      },
      { mode: "permissive" },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(DynamicRegistrationError);
    expect((err as DynamicRegistrationError).error_code).toBe("registration_response_invalid");
    await idp.close();
  });
});

describe("dynamicallyRegisterClient — allowInsecureRequests", () => {
  test("allowInsecureRequests: true allows http:// discovery", async () => {
    idp = await startMockIdP();
    const result = await dynamicallyRegisterClient(
      {
        issuerUrl: idp.baseUrl,
        clientMetadata: { redirect_uris: ["https://example.com/callback"] },
        allowInsecureRequests: true,
      },
      { mode: "permissive" },
    );
    expect(result.clientId).toBeTruthy();
    await idp.close();
  });

  test("clientMetadata fields are forwarded to the registration POST", async () => {
    let capturedBody: Record<string, unknown> = {};
    const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (
        url.pathname.includes("openid-configuration") ||
        url.pathname.includes("oauth-authorization-server")
      ) {
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            issuer: base,
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
            registration_endpoint: `${base}/register`,
          }),
        );
        return;
      }
      if (url.pathname === "/register" && req.method === "POST") {
        const raw = await readBody(req);
        capturedBody = JSON.parse(raw) as Record<string, unknown>;
        res.statusCode = 201;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ client_id: "c1" }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;

    await dynamicallyRegisterClient(
      {
        issuerUrl: base,
        clientMetadata: {
          redirect_uris: ["https://app.example.com/callback"],
          client_name: "My Test App",
          scope: "openid profile",
        },
        allowInsecureRequests: true,
      },
      { mode: "permissive" },
    );

    expect(capturedBody.client_name).toBe("My Test App");
    expect(capturedBody.scope).toBe("openid profile");
    expect(Array.isArray(capturedBody.redirect_uris)).toBe(true);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
