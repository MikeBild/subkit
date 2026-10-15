import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import type { OidcBearerProviderConfig } from "../config/schema.ts";
import { FROZEN_NOW } from "./determinism/clock.ts";
import { startLocalTargetServer } from "./local-http.ts";

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

export interface TestBearerIssuer {
  issuer: string;
  jwksFetches: () => number;
  discoveryFetches: () => number;
  setDiscoveryAvailable: (available: boolean) => void;
  provider: (overrides?: Partial<OidcBearerProviderConfig>) => OidcBearerProviderConfig;
  mint: (claims: Record<string, unknown>, options?: MintOptions) => Promise<string>;
  rotate: () => Promise<string>;
  stop: () => Promise<void>;
}

export interface MintOptions {
  kid?: string;
  alg?: string;
  key?: SigningKey | Uint8Array;
  issuedAt?: number;
  expiresIn?: number;
  issuer?: string;
  audience?: string;
}

export const BEARER_NOW_SECONDS = Math.floor(FROZEN_NOW / 1000);

export async function startTestBearerIssuer(): Promise<TestBearerIssuer> {
  const keys: Array<{ kid: string; privateKey: SigningKey; publicJwk: JWK }> = [];
  async function addKey(): Promise<string> {
    const pair = await generateKeyPair("ES256", { extractable: true });
    const kid = `key-${keys.length + 1}`;
    const publicJwk = { ...(await exportJWK(pair.publicKey)), kid, alg: "ES256", use: "sig" };
    keys.push({ kid, privateKey: pair.privateKey, publicJwk });
    return kid;
  }
  await addKey();
  let published = 1;
  let jwks = 0;
  let discovery = 0;
  let discoveryAvailable = true;
  let issuer = "";
  const server = await startLocalTargetServer((req) => {
    const path = new URL(req.url).pathname;
    if (path === "/auth/v1/.well-known/openid-configuration") {
      discovery += 1;
      if (!discoveryAvailable) return new Response("unavailable", { status: 503 });
      return Response.json({ issuer, jwks_uri: `${issuer}/.well-known/jwks.json` });
    }
    if (path === "/auth/v1/.well-known/jwks.json") {
      jwks += 1;
      return Response.json({ keys: keys.slice(0, published).map((key) => key.publicJwk) });
    }
    return new Response("not found", { status: 404 });
  });
  issuer = `${server.url}/auth/v1`;

  return {
    issuer,
    jwksFetches: () => jwks,
    discoveryFetches: () => discovery,
    setDiscoveryAvailable: (available) => {
      discoveryAvailable = available;
    },
    provider: (overrides = {}) => ({
      protocol: "oidc_bearer",
      id: "tekit-supabase",
      label: "TE-Kit account",
      issuer_url: issuer,
      audience: "authenticated",
      algorithms: ["ES256"],
      product_id: "tekit",
      tenant_slug: "default",
      required_claims: [{ path: "role", equals: "authenticated" }],
      reject_anonymous: true,
      clock_tolerance_s: 30,
      ...overrides,
    }),
    async mint(claims, options = {}) {
      const signing = keys.find((key) => key.kid === (options.kid ?? keys[0]?.kid));
      const iat = options.issuedAt ?? BEARER_NOW_SECONDS;
      const alg = options.alg ?? "ES256";
      return new SignJWT({ role: "authenticated", ...claims })
        .setProtectedHeader({ alg, kid: options.kid ?? signing?.kid ?? "key-1", typ: "JWT" })
        .setIssuer(options.issuer ?? issuer)
        .setAudience(options.audience ?? "authenticated")
        .setIssuedAt(iat)
        .setExpirationTime(iat + (options.expiresIn ?? 3600))
        .sign(options.key ?? (signing?.privateKey as SigningKey));
    },
    async rotate() {
      const kid = await addKey();
      published = keys.length;
      return kid;
    },
    stop: server.stop,
  };
}

export async function addUnpublishedKey(): Promise<SigningKey> {
  return (await generateKeyPair("ES256", { extractable: true })).privateKey;
}

export function unsignedToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(claims)}.`;
}
