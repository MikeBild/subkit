// `CredentialBody` (wire shape) → `DecryptedCredential` (what drivers sign with).
//
// Extracted so the two callers cannot drift: attaching a credential to a saved
// connector, and probing a connector that is not saved yet. Both accept the same
// JSON, so both must reject the same incomplete JSON — a probe that accepted a
// `basic` credential with no password would report a connectivity failure for
// what is really a malformed request.

import type { CredentialPlaintext, DecryptedCredential } from "../../../credentials/index.ts";
import { BadRequestError } from "../../errors.ts";

/**
 * The modes `CredentialBody` can express — the static ones a caller supplies
 * directly. The OAuth and token-mint modes are deliberately absent: those are
 * produced by a grant flow, not pasted into a request body.
 *
 * Narrowing to this subset is what lets one function serve both callers: the
 * result is assignable to `CredentialPlaintext` (what gets encrypted and
 * stored) and to `DecryptedCredential` (what a driver signs with).
 */
export type StaticCredentialValue = Extract<
  CredentialPlaintext & DecryptedCredential,
  { mode: "none" | "header" | "query" | "bearer" | "basic" | "aws_sigv4" }
>;

/** The wire shape, structurally. Mirrors `CredentialBody` in `./schemas.ts`. */
export interface CredentialBodyInput {
  mode: "none" | "header" | "query" | "bearer" | "basic" | "aws_sigv4" | "connection";
  headers?: Record<string, string> | undefined;
  query?: Record<string, string> | undefined;
  token?: string | undefined;
  username?: string | undefined;
  password?: string | undefined;
  access_key_id?: string | undefined;
  secret_access_key?: string | undefined;
  session_token?: string | undefined;
}

/**
 * Build the credential value for a mode, or throw `BadRequestError` naming the
 * field that is missing.
 *
 * Zod cannot express these per-mode requirements without turning the body into
 * a discriminated union, which would change the published schema; the checks
 * live here instead and are the single source of that truth.
 */
export function credentialBodyToValue(body: CredentialBodyInput): StaticCredentialValue {
  switch (body.mode) {
    case "connection":
      // Handled by the route before this point: a connection is a pointer,
      // not material, so there is no static value to build from it.
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
