import { describe, expect, test } from "bun:test";
import { DomainRefusal } from "../logging/index.ts";
import {
  connectorTemplateUnknown,
  connectorWriteAccepted,
  connectorWriteRejected,
} from "./core/write-rejection.ts";
import { ConnectorWriteRejectedError, connectorWriteValue } from "./write-rejected-error.ts";

describe("connector write value", () => {
  test("an accepted outcome unwraps to its value", () => {
    expect(connectorWriteValue(connectorWriteAccepted(7))).toBe(7);
  });

  test("a rejected outcome unwraps to a domain refusal carrying code, message and details", () => {
    const outcome = connectorWriteRejected<number>(connectorTemplateUnknown("ghost"));
    let thrown: unknown = null;
    try {
      connectorWriteValue(outcome);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConnectorWriteRejectedError);
    expect(thrown).toBeInstanceOf(DomainRefusal);
    expect(thrown).toMatchObject({
      code: "connector_template_unknown",
      message: "unknown connector template: ghost",
      details: { template_slug: "ghost" },
    });
  });
});
