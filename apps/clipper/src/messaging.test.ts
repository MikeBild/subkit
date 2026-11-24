import { expect, test } from "bun:test";
import { type MessageResponse, respondWith, unwrapResponse } from "./messaging.ts";

function responseSpy() {
  const responses: MessageResponse[] = [];
  let resolveResponse: (response: MessageResponse) => void = () => {};
  const delivered = new Promise<MessageResponse>((resolve) => {
    resolveResponse = resolve;
  });
  const sendResponse = (response: MessageResponse) => {
    responses.push(response);
    resolveResponse(response);
  };
  return { delivered, responses, sendResponse };
}

test("respondWith keeps the channel open and delivers the resolved value", async () => {
  const spy = responseSpy();
  expect(respondWith(Promise.resolve({ id: "draft" }), spy.sendResponse)).toBe(true);
  expect(await spy.delivered).toEqual({ ok: true, value: { id: "draft" } });
  expect(spy.responses).toHaveLength(1);
});

test("respondWith delivers a rejection as an error response", async () => {
  const spy = responseSpy();
  expect(respondWith(Promise.reject(new Error("Draft missing")), spy.sendResponse)).toBe(true);
  expect(await spy.delivered).toEqual({ ok: false, error: "Draft missing" });
});

test("unwrapResponse returns wrapped values and throws wrapped errors", () => {
  expect(unwrapResponse({ ok: true, value: [1, 2] })).toEqual([1, 2]);
  expect(unwrapResponse({ ok: true })).toBeUndefined();
  expect(() => unwrapResponse({ ok: false, error: "Draft missing" })).toThrow("Draft missing");
});

test("unwrapResponse accepts legacy raw values", () => {
  const draft = { id: "draft", body: "Body" };
  expect(unwrapResponse(draft)).toBe(draft);
  expect(unwrapResponse(undefined)).toBeUndefined();
});
