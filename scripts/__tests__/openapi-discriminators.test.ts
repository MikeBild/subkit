import { describe, expect, test } from "bun:test";
import { completeDiscriminatorMappings } from "../lib/openapi-discriminators.ts";

function spec() {
  return {
    components: {
      schemas: {
        Http: { type: "object", properties: { protocol: { type: "string", enum: ["http"] } } },
        Sql: { type: "object", properties: { protocol: { type: "string", enum: ["sql"] } } },
        Loose: { type: "object", properties: { protocol: { type: "string" } } },
        Step: {
          oneOf: [
            { $ref: "#/components/schemas/Http" },
            { $ref: "#/components/schemas/Sql" },
            { $ref: "#/components/schemas/Loose" },
          ],
          discriminator: {
            propertyName: "protocol",
            mapping: { sql: "#/components/schemas/Sql" },
          },
        },
      },
    },
  };
}

describe("discriminator mappings", () => {
  test("a member whose discriminator is a single-value enum is added to the mapping", () => {
    const doc = spec();
    completeDiscriminatorMappings(doc);
    expect(doc.components.schemas.Step.discriminator.mapping).toEqual({
      sql: "#/components/schemas/Sql",
      http: "#/components/schemas/Http",
    });
  });

  test("a member without a fixed value and an existing entry stay as they are", () => {
    const doc = spec();
    doc.components.schemas.Step.discriminator.mapping = {
      sql: "#/components/schemas/Sql",
      http: "#/components/schemas/Sql",
    } as typeof doc.components.schemas.Step.discriminator.mapping & { http: string };
    completeDiscriminatorMappings(doc);
    expect(doc.components.schemas.Step.discriminator.mapping).toEqual({
      sql: "#/components/schemas/Sql",
      http: "#/components/schemas/Sql",
    });
  });
});
