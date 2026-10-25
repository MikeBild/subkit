import { describe, expect, test } from "bun:test";
import { endpointKeyPath } from "./call-connector.ts";

describe("endpointKeyPath", () => {
  test("drops the query so repeated probes of one route share a recorded shape", () => {
    expect(endpointKeyPath("/v1/forecast?daily=temperature_2m_min")).toBe("/v1/forecast");
    expect(endpointKeyPath("/v1/forecast?daily=temperature_2m_max")).toBe("/v1/forecast");
  });

  test("keeps the pathname of an absolute url", () => {
    expect(endpointKeyPath("https://api.example.com/v1/forecast?x=1")).toBe("/v1/forecast");
  });
});
