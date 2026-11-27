import { expect, test } from "bun:test";
import { paymentAttentionItem, signInAttentionItem } from "./vault-payment-attention.ts";

test("a pending payment is a decision with structured, value-free facts", () => {
  const item = paymentAttentionItem({
    id: "p1",
    status: "pending",
    origin: "https://shop.example",
    amount_minor: 500,
    currency: "JPY",
    card: { brand: "visa", last4: "4242" },
    expires_at: "2026-11-27T10:15:00.000Z",
    created_at: "2026-11-27T10:00:00.000Z",
    conversation_id: "c1",
    task_run_id: null,
  });
  expect(item).toMatchObject({
    reason: "payment_approval_needed",
    detail: null,
    subject: { kind: "conversation", id: "c1", name: "https://shop.example" },
    vault: { kind: "payment", id: "p1", amount_minor: 500, currency: "JPY" },
    actions: [{ href: "/cockpit/chat/c1?payment=p1", permission: "conversation:write" }],
  });
});

test("a pending sign-in names the site and links to its chat", () => {
  const item = signInAttentionItem({
    tool_call_id: "t1",
    conversation_id: "c1",
    origin: "https://shop.example",
    since: new Date("2026-11-27T10:00:00Z"),
    deadline: null,
  });
  expect(item).toMatchObject({
    reason: "sign_in_confirmation_needed",
    vault: { kind: "sign_in", id: "t1", origin: "https://shop.example" },
    actions: [{ href: "/cockpit/chat/c1" }],
  });
});
