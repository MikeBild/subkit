import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../openapi.ts";
import { versionHeaderMiddleware } from "./version-header.ts";

describe("versionHeaderMiddleware", () => {
  test("names the engine version on every response, errors included", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", versionHeaderMiddleware("12.1.0"));
    app.get("/ok", (c) => c.text("ok"));
    app.get("/missing", (c) => c.text("no", 404));
    expect((await app.request("/ok")).headers.get("x-subkit-version")).toBe("12.1.0");
    expect((await app.request("/missing")).headers.get("x-subkit-version")).toBe("12.1.0");
  });
});
