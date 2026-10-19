import { beforeEach, describe, expect, mock, test } from "bun:test";
import { withSelfHostedDriverFetchForTests } from "../../../test-helpers/driver-fetch.ts";
import { runTokenMintGrant } from "../client.ts";

let fetchSpy: ReturnType<typeof mock<typeof fetch>>;

beforeEach(() => {
  fetchSpy = mock<typeof fetch>();
});

function seamTest(name: string, body: () => Promise<void>) {
  test(name, () => withSelfHostedDriverFetchForTests(fetchSpy as unknown as typeof fetch, body));
}

describe("runTokenMintGrant — shape: aws_initiate_auth (Cognito)", () => {
  seamTest(
    "posts USER_PASSWORD_AUTH with x-amz-target and parses AuthenticationResult",
    async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({
            AuthenticationResult: {
              IdToken: "eyJ.id-token",
              RefreshToken: "rt-1",
              ExpiresIn: 3600,
            },
          }),
          { status: 200 },
        ),
      );
      const bundle = await runTokenMintGrant(
        {
          shape: "aws_initiate_auth",
          mint_endpoint: "https://cognito-idp.eu-central-1.amazonaws.com/",
          credentials: { username: "user@example.com", password: "pw", client_id: "abc" },
          token_path: "AuthenticationResult.IdToken",
          refresh_token_path: "AuthenticationResult.RefreshToken",
          expires_in_path: "AuthenticationResult.ExpiresIn",
        },
        { mode: "permissive" },
      );
      const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers["x-amz-target"]).toBe("AWSCognitoIdentityProviderService.InitiateAuth");
      expect(headers["content-type"]).toBe("application/x-amz-json-1.1");
      const body = JSON.parse(String(init.body));
      expect(body.AuthFlow).toBe("USER_PASSWORD_AUTH");
      expect(body.ClientId).toBe("abc");
      expect(body.AuthParameters.USERNAME).toBe("user@example.com");
      expect(bundle.access_token).toBe("eyJ.id-token");
      expect(bundle.refresh_token).toBe("rt-1");
      expect(bundle.expires_at).toBeInstanceOf(Date);
      const ageMs = bundle.expires_at!.getTime() - Date.now(); // allow-wall-clock: this assertion exists to verify wall-time math the client itself runs
      expect(ageMs).toBeLessThanOrEqual(3_600_000);
      expect(ageMs).toBeGreaterThan(3_590_000);
    },
  );

  seamTest("computes SECRET_HASH when client_secret is provided", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ AuthenticationResult: { IdToken: "x", ExpiresIn: 60 } }), {
        status: 200,
      }),
    );
    await runTokenMintGrant(
      {
        shape: "aws_initiate_auth",
        mint_endpoint: "https://cognito-idp.eu-central-1.amazonaws.com/",
        credentials: {
          username: "user@example.com",
          password: "pw",
          client_id: "abc",
          client_secret: "shh",
        },
        token_path: "AuthenticationResult.IdToken",
      },
      { mode: "permissive" },
    );
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(typeof body.AuthParameters.SECRET_HASH).toBe("string");
    expect(body.AuthParameters.SECRET_HASH.length).toBeGreaterThan(20);
  });
});

describe("runTokenMintGrant — shape: json (Firebase / generic)", () => {
  seamTest("posts JSON body with email/password and parses idToken (Firebase shape)", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ idToken: "fb-id", refreshToken: "fb-rt", expiresIn: "3600" }), {
        status: 200,
      }),
    );
    const bundle = await runTokenMintGrant(
      {
        shape: "json",
        mint_endpoint:
          "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=API_KEY",
        credentials: { username: "u@e.com", password: "p" },
        token_path: "idToken",
        refresh_token_path: "refreshToken",
        expires_in_path: "expiresIn",
      },
      { mode: "permissive" },
    );
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    const body = JSON.parse(String(init.body));
    expect(body.username).toBe("u@e.com");
    expect(body.returnSecureToken).toBe(true);
    expect(bundle.access_token).toBe("fb-id");
    expect(bundle.refresh_token).toBe("fb-rt");
    expect(bundle.expires_at).toBeInstanceOf(Date);
  });
});

describe("runTokenMintGrant — shape: form (OAuth2 password / generic)", () => {
  seamTest("posts urlencoded body with username/password and parses access_token", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ access_token: "oa-tok", expires_in: 3600 }), { status: 200 }),
    );
    const bundle = await runTokenMintGrant(
      {
        shape: "form",
        mint_endpoint: "https://example.test/oauth/token",
        credentials: { username: "u", password: "p", client_id: "id", client_secret: "sec" },
        token_path: "access_token",
        expires_in_path: "expires_in",
      },
      { mode: "permissive" },
    );
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const params = new URLSearchParams(String(init.body));
    expect(params.get("username")).toBe("u");
    expect(params.get("password")).toBe("p");
    expect(params.get("client_id")).toBe("id");
    expect(params.get("client_secret")).toBe("sec");
    expect(bundle.access_token).toBe("oa-tok");
    expect(bundle.expires_at).toBeInstanceOf(Date);
  });
});

describe("runTokenMintGrant — error paths", () => {
  seamTest("non-2xx response exposes status without upstream content", async () => {
    fetchSpy.mockResolvedValue(new Response("body-canary token-canary", { status: 401 }));
    let caught: Error | null = null;
    try {
      await runTokenMintGrant(
        {
          shape: "form",
          mint_endpoint: "https://example.test/oauth/token",
          credentials: { username: "u", password: "p" },
          token_path: "access_token",
        },
        { mode: "permissive" },
      );
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.message).toContain("401");
    expect(caught?.message).toBe("credential_response_rejected: http_401");
    expect(caught?.message).not.toContain("body-canary");
    expect(caught?.message).not.toContain("token-canary");
  });

  seamTest("missing token at token_path throws", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ unexpected: "x" }), { status: 200 }));
    let caught: Error | null = null;
    try {
      await runTokenMintGrant(
        {
          shape: "json",
          mint_endpoint: "https://example.test",
          credentials: { username: "u", password: "p" },
          token_path: "id_token",
        },
        { mode: "permissive" },
      );
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.message).toBe("credential_response_invalid");
  });

  seamTest("aws_initiate_auth without client_id throws synchronously (before fetch)", async () => {
    let caught: Error | null = null;
    try {
      await runTokenMintGrant(
        {
          shape: "aws_initiate_auth",
          mint_endpoint: "https://cognito-idp.eu-central-1.amazonaws.com/",
          credentials: { username: "u", password: "p" },
          token_path: "AuthenticationResult.IdToken",
        },
        { mode: "permissive" },
      );
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.message).toContain("requires credentials.client_id");
  });
});
