import { describe, expect, test } from "bun:test";
import { categoryOfConnector } from "./categorize.ts";

describe("categoryOfConnector", () => {
  test("groups a connector by its stored driver", () => {
    expect(categoryOfConnector({ driver: "http" })).toBe("http");
    expect(categoryOfConnector({ driver: "postgres" })).toBe("postgres");
    expect(categoryOfConnector({ driver: "graphql" })).toBe("graphql");
    expect(categoryOfConnector({ driver: "s3" })).toBe("s3");
  });
});
