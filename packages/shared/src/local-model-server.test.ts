import { describe, expect, test } from "bun:test";
import { loopbackModelOrigin } from "./local-model-server.ts";

describe("a local model server", () => {
  test("is a loopback origin without a path, user or query", () => {
    expect(loopbackModelOrigin("http://localhost:11434")).toBe("http://localhost:11434");
    expect(loopbackModelOrigin(" http://127.0.0.1:8080/ ")).toBe("http://127.0.0.1:8080");
    expect(loopbackModelOrigin("https://[::1]:1234")).toBe("https://[::1]:1234");
    for (const refused of [
      "http://192.168.1.4:11434",
      "http://models.example.test",
      "http://localhost:11434/v1",
      "http://user:pw@localhost:11434",
      "http://user@localhost:11434",
      "http://:pw@localhost:11434",
      "http://localhost:11434/?a=1",
      "http://localhost:11434/#x",
      "ftp://localhost",
      "localhost:11434",
      "",
    ])
      expect(loopbackModelOrigin(refused)).toBeNull();
  });
});
