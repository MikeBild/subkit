import { describe, expect, test } from "bun:test";
import { incomingFromLaunchFiles, incomingReceiptForIdentity } from "./installation-provider";

const identity = { tenantId: "tenant-a", userId: "user-a" };

describe("installation provider receipt boundary", () => {
  test("accepts one bounded receipt only for the authenticated installation identity", () => {
    const receipt = {
      title: "",
      text: "untrusted share",
      url: "",
      files: [],
      tenantId: "tenant-a",
      userId: "user-a",
    };
    expect(incomingReceiptForIdentity(receipt, identity)).toEqual(receipt);
  });

  test("drops stale or malformed worker receipts before they reach a UI", () => {
    const receipt = {
      title: "",
      text: "untrusted share",
      url: "",
      files: [],
      tenantId: "tenant-b",
      userId: "user-a",
    };
    expect(incomingReceiptForIdentity(receipt, identity)).toBeNull();
    expect(
      incomingReceiptForIdentity(
        { ...identity, title: "", text: "", url: "javascript:alert(1)", files: [] },
        identity,
      ),
    ).toBeNull();
  });

  test("reads only a bounded native file launch after the platform hands over file handles", async () => {
    const value = await incomingFromLaunchFiles([
      { getFile: async () => new File(["notes"], "notes.md", { type: "text/markdown" }) },
    ]);
    expect(value.files[0]?.name).toBe("notes.md");
    const handles = Array.from({ length: 11 }, () => ({
      getFile: async () => new File(["x"], "x.txt"),
    }));
    await expect(incomingFromLaunchFiles(handles)).rejects.toThrow("incoming_too_many_files");
  });
});
