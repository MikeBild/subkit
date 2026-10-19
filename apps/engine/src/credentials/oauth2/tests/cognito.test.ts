import { beforeEach, describe, expect, mock, test } from "bun:test";
import { getTestNow } from "../../../test-helpers/determinism/clock.ts";
import { withSelfHostedDriverFetchForTests } from "../../../test-helpers/driver-fetch.ts";
import { runCognitoRefreshTokenGrant, runCognitoUserPasswordGrant } from "../client.ts";

const TEST_NOW_MS = getTestNow();

describe("Cognito User-Password (InitiateAuth)", () => {
  let fetchSpy: ReturnType<typeof mock<typeof fetch>>;

  beforeEach(() => {
    fetchSpy = mock<typeof fetch>();
  });

  function seamTest(name: string, body: () => Promise<void>) {
    test(name, () => withSelfHostedDriverFetchForTests(fetchSpy as unknown as typeof fetch, body));
  }

  seamTest("posts USER_PASSWORD_AUTH body to cognito-idp endpoint", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          AuthenticationResult: {
            IdToken: "eyJraWQ.id-token",
            AccessToken: "eyJraWQ.access-token",
            RefreshToken: "rt-1",
            ExpiresIn: 3600,
            TokenType: "Bearer",
          },
        }),
        { status: 200, headers: { "content-type": "application/x-amz-json-1.1" } },
      ),
    );

    const bundle = await runCognitoUserPasswordGrant(
      {
        region: "eu-central-1",
        client_id: "abc123",
        username: "user@example.com",
        password: "hunter2",
      },
      { mode: "permissive" },
    );

    const call = fetchSpy.mock.calls[0];
    expect(call?.[0]).toBe("https://cognito-idp.eu-central-1.amazonaws.com/");
    const init = call?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/x-amz-json-1.1");
    expect(headers["x-amz-target"]).toBe("AWSCognitoIdentityProviderService.InitiateAuth");
    const body = JSON.parse(String(init?.body));
    expect(body.AuthFlow).toBe("USER_PASSWORD_AUTH");
    expect(body.ClientId).toBe("abc123");
    expect(body.AuthParameters.USERNAME).toBe("user@example.com");
    expect(body.AuthParameters.PASSWORD).toBe("hunter2");
    expect(body.AuthParameters.SECRET_HASH).toBeUndefined();

    expect(bundle.access_token).toBe("eyJraWQ.id-token");
    expect(bundle.token_type).toBe("none");
    expect(bundle.refresh_token).toBe("rt-1");
    expect(bundle.expires_at).toBeInstanceOf(Date);
    expect(bundle.expires_at!.getTime()).toBeGreaterThan(TEST_NOW_MS);
  });

  seamTest("computes SECRET_HASH when client_secret is provided", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          AuthenticationResult: {
            IdToken: "tok",
            ExpiresIn: 60,
          },
        }),
        { status: 200 },
      ),
    );

    await runCognitoUserPasswordGrant(
      {
        region: "us-east-1",
        client_id: "client-with-secret",
        client_secret: "shh",
        username: "user@example.com",
        password: "pw",
      },
      { mode: "permissive" },
    );

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(typeof body.AuthParameters.SECRET_HASH).toBe("string");
    expect(body.AuthParameters.SECRET_HASH.length).toBeGreaterThan(20);
  });

  seamTest("use_access_token=true persists AccessToken instead of IdToken", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          AuthenticationResult: {
            IdToken: "id-tok",
            AccessToken: "ac-tok",
            ExpiresIn: 60,
          },
        }),
        { status: 200 },
      ),
    );

    const bundle = await runCognitoUserPasswordGrant(
      {
        region: "eu-west-1",
        client_id: "abc",
        username: "u",
        password: "p",
        use_access_token: true,
      },
      { mode: "permissive" },
    );
    expect(bundle.access_token).toBe("ac-tok");
  });

  seamTest("propagates AWS error responses", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          __type: "NotAuthorizedException",
          message: "Incorrect username or password.",
        }),
        { status: 400 },
      ),
    );

    let caught: Error | null = null;
    try {
      await runCognitoUserPasswordGrant(
        {
          region: "eu-central-1",
          client_id: "abc",
          username: "u",
          password: "wrong",
        },
        { mode: "permissive" },
      );
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.message).toContain("400");
    expect(caught?.message).toBe("credential_response_rejected: http_400");
    expect(caught?.message).not.toContain("NotAuthorizedException");
  });

  seamTest("REFRESH_TOKEN_AUTH posts refresh token in AuthParameters", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          AuthenticationResult: {
            IdToken: "fresh-id",
            ExpiresIn: 3600,
          },
        }),
        { status: 200 },
      ),
    );

    const bundle = await runCognitoRefreshTokenGrant(
      {
        region: "eu-central-1",
        client_id: "abc",
        username: "u@example.com",
        password: "",
        refresh_token: "rt-existing",
      },
      { mode: "permissive" },
    );

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.AuthFlow).toBe("REFRESH_TOKEN_AUTH");
    expect(body.AuthParameters.REFRESH_TOKEN).toBe("rt-existing");

    expect(bundle.access_token).toBe("fresh-id");
    expect(bundle.token_type).toBe("none");
    expect(bundle.refresh_token).toBe("rt-existing");
  });

  seamTest("missing AuthenticationResult throws a clear error", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    let caught: Error | null = null;
    try {
      await runCognitoUserPasswordGrant(
        {
          region: "eu-central-1",
          client_id: "abc",
          username: "u",
          password: "p",
        },
        { mode: "permissive" },
      );
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.message).toBe("credential_response_invalid");
  });

  seamTest(
    "REFRESH_TOKEN_AUTH with client_secret computes SECRET_HASH from the persisted username (not empty)",
    async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({
            AuthenticationResult: { IdToken: "fresh", ExpiresIn: 60 },
          }),
          { status: 200 },
        ),
      );
      await runCognitoRefreshTokenGrant(
        {
          region: "eu-central-1",
          client_id: "abc-secret",
          client_secret: "shh",
          username: "user@example.com",
          password: "",
          refresh_token: "rt",
        },
        { mode: "permissive" },
      );
      const initWithUser = fetchSpy.mock.calls[0]?.[1] as RequestInit;
      const bodyWithUser = JSON.parse(String(initWithUser.body));
      expect(typeof bodyWithUser.AuthParameters.SECRET_HASH).toBe("string");
      const hashWithUser = bodyWithUser.AuthParameters.SECRET_HASH as string;

      fetchSpy.mockClear();
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({
            AuthenticationResult: { IdToken: "fresh", ExpiresIn: 60 },
          }),
          { status: 200 },
        ),
      );
      await runCognitoRefreshTokenGrant(
        {
          region: "eu-central-1",
          client_id: "abc-secret",
          client_secret: "shh",
          username: "",
          password: "",
          refresh_token: "rt",
        },
        { mode: "permissive" },
      );
      const initEmpty = fetchSpy.mock.calls[0]?.[1] as RequestInit;
      const bodyEmpty = JSON.parse(String(initEmpty.body));
      const hashEmpty = bodyEmpty.AuthParameters.SECRET_HASH as string;
      expect(hashEmpty).not.toBe(hashWithUser);
    },
  );
});
