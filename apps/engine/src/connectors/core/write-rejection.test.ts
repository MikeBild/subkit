import { describe, expect, test } from "bun:test";
import {
  CONNECTOR_TEMPLATE_CONFLICT,
  connectorTemplateUnknown,
  connectorWriteRejectionDetails,
} from "./write-rejection.ts";

describe("connector write rejection", () => {
  test("an unknown template names the slug in message and details", () => {
    expect(connectorTemplateUnknown("ghost")).toEqual({
      code: "connector_template_unknown",
      message: "unknown connector template: ghost",
      details: { template_slug: "ghost" },
    });
  });

  test("only rejections with details expose them", () => {
    expect(connectorWriteRejectionDetails(connectorTemplateUnknown("ghost"))).toEqual({
      template_slug: "ghost",
    });
    expect(connectorWriteRejectionDetails(CONNECTOR_TEMPLATE_CONFLICT)).toBeUndefined();
  });
});
