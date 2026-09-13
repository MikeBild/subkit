// GET /v1/identity/providers — public, sanitised inventory of the ways a person
// or a program can sign in here.
//
// PUBLIC IS A FAMILY RULE, decided 2026-09-04, not a local preference. A caller
// that has no credential yet is exactly the caller that needs to know which
// credentials exist, so requiring one is circular. This route answered 401 for
// a while, on the reasoning that an installation-specific list should not be
// disclosed before authentication; that reasoning survives here as WHAT is
// disclosed rather than WHO may ask.
//
// What leaves this route: the protocol, the adapter id, and a GENERIC label for
// the protocol. What never leaves it: issuer URLs, client ids, allow lists,
// scopes, tenant slugs — and the operator's own wording. An operator-typed
// label can carry the name of a company, and the anonymous answer is not the
// place to publish it. That is also why the answer is identical whether or not
// the caller is signed in: two different answers would make this route a probe
// for whether a credential is valid.
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";

import type { AppEnv } from "../../openapi.ts";

const ProviderEntry = z
  .object({
    protocol: z.enum(["api_key", "oidc"]),
    id: z.string(),
    label: z.string().min(1),
  })
  .strict()
  .openapi("AuthProvider");

const ProvidersResponse = z
  .object({
    providers: z.array(ProviderEntry),
  })
  .strict()
  .openapi("ProvidersResponse");

/** The only labels this route emits — one per protocol, never the operator's. */
const LABELS: Record<"api_key" | "oidc", string> = {
  oidc: "SSO",
  api_key: "API key",
};

const route = createRoute({
  method: "get",
  path: "/v1/identity/providers",
  tags: ["MCP authentication"],
  summary: "List configured authentication methods",
  description:
    "Public. Returns the sign-in methods this installation offers, with a generic label per protocol. No issuer, client id, scope or operator wording is included, and the answer does not change when the caller is authenticated.",
  responses: {
    200: {
      description: "Sanitised provider inventory",
      content: { "application/json": { schema: ProvidersResponse } },
    },
  },
});

export function registerProvidersRoute(app: OpenAPIHono<AppEnv>): void {
  app.openapi(route, async (c) => {
    const { getConfig } = await import("../../../config/loader.ts");
    const providers: z.infer<typeof ProviderEntry>[] = [...getConfig().auth.providers]
      .sort(
        (left, right) => Number(left.protocol === "api_key") - Number(right.protocol === "api_key"),
      )
      .map((provider) => ({
        protocol: provider.protocol,
        id: provider.id,
        label: LABELS[provider.protocol],
      }));

    return c.json({ providers }, 200);
  });
}
