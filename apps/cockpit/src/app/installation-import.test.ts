import { expect, test } from "bun:test";
import type { apiRequest } from "@/api/client";
import { confirmInstallationImport, prepareInstallationImport } from "./installation-import";

const identity = { tenantId: "tenant", userId: "owner" };
const destination = { ...identity, category: "Collected", origin: "https://app.example.test" };

test("prepares locally and writes only collected intake after explicit confirmation", async () => {
  const draft = await prepareInstallationImport(
    {
      title: "Source",
      text: "Original source text",
      url: "https://source.example.test/article",
      files: [],
    },
    identity,
  );
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const request: typeof apiRequest = async <T>(path: string, init: RequestInit = {}) => {
    calls.push({ path, body: JSON.parse(String(init.body)) });
    return { id: "collected-item" } as T;
  };
  expect(calls).toHaveLength(0);
  expect(await confirmInstallationImport(draft, destination, request)).toEqual({
    itemIds: ["collected-item"],
    fileIds: [],
  });
  expect(calls.map((call) => call.path)).toEqual(["/v1/intake/items"]);
  expect(calls[0]?.body).toMatchObject({
    category: "Collected",
    source_url: "https://source.example.test/article",
    body: "Original source text",
  });
  expect(calls[0]?.body).not.toHaveProperty("source_author");
  await confirmInstallationImport(draft, destination, request);
  expect(calls).toHaveLength(1);
});

test("retains exact uploaded file reference and idempotency key across an intake retry", async () => {
  const draft = await prepareInstallationImport(
    {
      title: "",
      text: "",
      url: "",
      files: [new File(["Review source"], "review.txt", { type: "text/plain" })],
    },
    identity,
  );
  const paths: string[] = [];
  const requests: unknown[] = [];
  let fail = true;
  const uncategorized = { ...destination, category: "" };
  const request: typeof apiRequest = async <T>(path: string, init: RequestInit = {}) => {
    paths.push(path);
    if (path === "/v1/files/inline") return { id: "stored-file" } as T;
    requests.push(JSON.parse(String(init.body)));
    if (fail) {
      fail = false;
      throw new Error("temporary failure");
    }
    return { id: "collected-file" } as T;
  };
  await expect(confirmInstallationImport(draft, uncategorized, request)).rejects.toThrow(
    "temporary failure",
  );
  await expect(confirmInstallationImport(draft, destination, request)).rejects.toThrow(
    "incoming_destination_changed",
  );
  expect(await confirmInstallationImport(draft, uncategorized, request)).toEqual({
    itemIds: ["collected-file"],
    fileIds: ["stored-file"],
  });
  expect(paths).toEqual(["/v1/files/inline", "/v1/intake/items", "/v1/intake/items"]);
  expect(requests[0]).toEqual(requests[1]);
  expect(requests[1]).toMatchObject({
    category: "",
    source_url: "https://app.example.test/v1/files/stored-file/content?tenant_context=tenant",
    original_snapshot: { origin: "capture", body: "Review source" },
  });
});

test("rejects changed identity or a changed destination before further writes", async () => {
  const draft = await prepareInstallationImport(
    { title: "", text: "Review source", url: "https://source.example.test/", files: [] },
    identity,
  );
  let calls = 0;
  const request: typeof apiRequest = async <T>() => {
    calls += 1;
    return { id: "item" } as T;
  };
  await expect(
    confirmInstallationImport(draft, { ...destination, tenantId: "other" }, request),
  ).rejects.toThrow("incoming_identity_changed");
  expect(calls).toBe(0);
  await confirmInstallationImport(draft, destination, request);
  await expect(
    confirmInstallationImport(draft, { ...destination, category: "Other" }, request),
  ).rejects.toThrow("incoming_destination_changed");
  expect(calls).toBe(1);
});
