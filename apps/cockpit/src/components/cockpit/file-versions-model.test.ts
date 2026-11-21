import { describe, expect, test } from "bun:test";
import { translate } from "@/lib/i18n";
import { fileOtherLinkCard, fileUsageParts } from "./file-versions-model";

const de = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
  translate("de", key, values);
describe("file usage summary", () => {
  test("says 'not used' only when nothing at all uses the file", () => {
    expect(fileUsageParts(de, { workflows: 0, conversations: 0, other: 0 })).toBeNull();
    expect(fileUsageParts(de, { workflows: 0, conversations: 0 })).toBeNull();
    expect(fileUsageParts(de, undefined)).toBeNull();
  });
});

describe("file usage names the other records", () => {
  test("a linked record is named and linked; a vanished one is said to be gone", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(
      fileOtherLinkCard({ resource_type: "knowledge_source", id, name: "Approval policy" }, de),
    ).toEqual({
      id: `knowledge_source-${id}`,
      title: "Approval policy",
      line: "Wissensquelle",
      href: `/knowledge/${id}`,
    });
    expect(fileOtherLinkCard({ resource_type: "skill", id, name: "Rule" }, de).href).toBe(
      `/skills/${id}`,
    );
    const gone = fileOtherLinkCard({ resource_type: "connector", id, name: null }, de);
    expect(gone.title).toBe("Nicht mehr vorhanden");
    expect(gone.href).toBeUndefined();
    expect(
      fileOtherLinkCard({ resource_type: "discovery_run", id, name: "Probe" }, de).href,
    ).toBeUndefined();
  });
});
