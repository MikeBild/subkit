import type { CredentialPlaintext, DecryptedCredential } from "../../../credentials/index.ts";
import { BadRequestError } from "../../errors.ts";

type StaticCredentialValue = Extract<
  CredentialPlaintext & DecryptedCredential,
  { mode: "none" | "header" | "query" | "bearer" | "basic" | "aws_sigv4" | "signed_jwt" }
>;

interface CredentialBodyInput {
  mode:
    | "none"
    | "header"
    | "query"
    | "bearer"
    | "basic"
    | "aws_sigv4"
    | "signed_jwt"
    | "connection";
  headers?: Record<string, string> | undefined;
  query?: Record<string, string> | undefined;
  token?: string | undefined;
  private_key?: string | undefined;
  username?: string | undefined;
  password?: string | undefined;
  access_key_id?: string | undefined;
  secret_access_key?: string | undefined;
  session_token?: string | undefined;
}

export function credentialBodyToValue(body: CredentialBodyInput): StaticCredentialValue {
  switch (body.mode) {
    case "connection":
      throw new BadRequestError("connection mode carries no credential value");
    case "none":
      return { mode: "none" };
    case "header":
      if (!body.headers) throw new BadRequestError("header mode requires headers");
      return { mode: "header", headers: body.headers };
    case "query":
      if (!body.query) throw new BadRequestError("query mode requires query");
      return { mode: "query", query: body.query };
    case "bearer":
      if (!body.token) throw new BadRequestError("bearer mode requires token");
      return { mode: "bearer", token: body.token };
    case "signed_jwt":
      if (!body.private_key) throw new BadRequestError("signed_jwt requires private_key");
      return { mode: "signed_jwt", private_key: body.private_key };
    case "basic":
      if (!body.username || body.password === undefined) {
        throw new BadRequestError("basic mode requires username and password");
      }
      return { mode: "basic", username: body.username, password: body.password };
    case "aws_sigv4":
      if (!body.access_key_id || !body.secret_access_key) {
        throw new BadRequestError("aws_sigv4 mode requires access_key_id and secret_access_key");
      }
      return {
        mode: "aws_sigv4",
        access_key_id: body.access_key_id,
        secret_access_key: body.secret_access_key,
        ...(body.session_token ? { session_token: body.session_token } : {}),
      };
  }
}
