import { afterAll, beforeAll, expect, test } from "bun:test";
import { connectors } from "../../db/schema/index.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { resolveScopeFactsForConversation } from "../scope-facts.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;
const nextId = createDeterministicUuidFactory(4_281);

beforeAll(async () => {
  ctx = await createConversationTestCtx("scope_facts");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function unboundConnector(slug: string, base_url: string): Promise<string> {
  const [row] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenant_id,
      slug,
      display_name: slug,
      driver: "http",
      auth_type: "none",
      environment: "dev",
      base_url,
    })
    .returning({ id: connectors.id });
  if (!row) throw new Error("expected a connector fixture");
  return row.id;
}

test("an unbound connector reports the built-in template its base URL and step path match", async () => {
  const hostOnly = await unboundConnector("mail-host-only", "https://gmail.googleapis.com");
  const withVersion = await unboundConnector(
    "mail-with-version",
    "https://gmail.googleapis.com/gmail/v1",
  );
  const facts = await resolveScopeFactsForConversation(ctx.testDb.db, ctx.tenant_id, nextId(), {
    steps: [
      { id: "a", connector_id: hostOnly, path: "/gmail/v1/users/me/messages/send" },
      { id: "b", connector_id: withVersion, path: "/users/me/messages/send" },
    ],
  });
  expect(facts.connector_templates).toEqual(["google-gmail"]);
});

test("an unbound connector on an unknown host reports no template", async () => {
  const id = await unboundConnector("unknown-host", "https://api.example.test");
  const facts = await resolveScopeFactsForConversation(ctx.testDb.db, ctx.tenant_id, nextId(), {
    steps: [{ id: "a", connector_id: id, path: "/gmail/v1/users/me/messages/send" }],
  });
  expect(facts.connector_templates).toEqual([]);
  expect(facts.connector_drivers).toEqual(["http"]);
});
