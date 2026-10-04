import { describe, expect, test } from "bun:test";
import { placeholderSlugsIn } from "./connector-refs.ts";

describe("placeholderSlugsIn", () => {
  test("extracts the slug from the documented base_url placeholder", () => {
    expect(placeholderSlugsIn("${connector.gmail.base_url}/messages")).toEqual(["gmail"]);
  });

  test("accepts the full validator slug charset", () => {
    expect(placeholderSlugsIn("${connector.my_api-v2.base_url}/x")).toEqual(["my_api-v2"]);
  });

  test("finds a placeholder that is not at the start of the url", () => {
    expect(placeholderSlugsIn("https://proxy/?to=${connector.stripe.base_url}")).toEqual([
      "stripe",
    ]);
  });

  test("counts a non-base_url property as a reference too", () => {
    expect(placeholderSlugsIn("${connector.notion.api_version}")).toEqual(["notion"]);
  });

  test("returns each slug once, in first-seen order", () => {
    expect(
      placeholderSlugsIn("${connector.b.base_url}/x/${connector.a.base_url}/${connector.b.token}"),
    ).toEqual(["b", "a"]);
  });

  test("ignores urls with no placeholder", () => {
    expect(placeholderSlugsIn("https://api.example.com/v1/things")).toEqual([]);
    expect(placeholderSlugsIn("")).toEqual([]);
  });

  test("does not match a malformed placeholder", () => {
    expect(placeholderSlugsIn("${connector..base_url}")).toEqual([]);
    expect(placeholderSlugsIn("${connectors.gmail.base_url}")).toEqual([]);
    expect(placeholderSlugsIn("${env.gmail.base_url}")).toEqual([]);
  });
});
