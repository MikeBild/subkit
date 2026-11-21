import { describe, expect, it } from "bun:test";
import type { components } from "@cli-core/engine-api/openapi";
import {
  awaitingAssistantReview,
  checkUploads,
  dropQueued,
  dropTarget,
  entryAttachment,
  entryOrigin,
  entryStrip,
  entryView,
  extOf,
  failedSourceRemedy,
  fileKindOf,
  fileSize,
  fileView,
  groupBy,
  isOpenEntry,
  lineDiff,
  MAX_FILE,
  matches,
  parseCsv,
  previewedUpload,
  relTime,
  sectionTarget,
  skillDraftChanges,
  skillDraftErrors,
  skillView,
  sourceKindOf,
  sourceView,
  suggestionFor,
} from "./model";

type IntakeItem = components["schemas"]["IntakeItem"];
type IntakeProposal = components["schemas"]["IntakeProposal"];

const NOW = Date.parse("2026-11-21T12:00:00Z");

function item(over: Partial<IntakeItem> = {}): IntakeItem {
  return {
    id: "i-1",
    tenant_id: "t",
    category: "ops",
    client_request_id: "c",
    title: "Vortrag Incident-Review",
    body: "## Text",
    note: "",
    state: "collected",
    version: 1,
    collected_by: { kind: "user", id: "u" },
    admitted_target_kind: null,
    admitted_target_id: null,
    created_at: "2026-11-21T10:00:00Z",
    updated_at: "2026-11-21T10:00:00Z",
    original_snapshot: {
      origin: "capture",
      title: "t",
      captured_at: "2026-11-21T10:00:00Z",
      body: "b",
      source_url: "https://talks.example.com/incident",
    },
    ...over,
  } as IntakeItem;
}

function proposal(
  over: Partial<IntakeProposal> = {},
  target: IntakeProposal["revision"]["target"] = { name: "Preise", tags: ["preise"] },
): IntakeProposal {
  return {
    id: "p-1",
    tenant_id: "t",
    status: "draft",
    current_revision: 2,
    confirmed_revision: null,
    confirmed_target_kind: null,
    confirmed_target_id: null,
    rejected_at: null,
    stale_reason: null,
    created_at: "2026-11-21T10:00:00Z",
    updated_at: "2026-11-21T11:00:00Z",
    revision: {
      revision: 2,
      digest: "d",
      title: "Preise Mitbewerber",
      body: "Preisseite einlesen.",
      target,
      items: [{ id: "i-1", version: 1, title: "x", source_url: null }],
      created_at: "2026-11-21T11:00:00Z",
    },
    ...over,
  } as IntakeProposal;
}

describe("list helpers", () => {
  it("matches is case-insensitive and an empty query matches everything", () => {
    expect(matches("", "x")).toBe(true);
    expect(matches("ORDERS", "Orders API", null)).toBe(true);
    expect(matches("zzz", "Orders API", undefined)).toBe(false);
  });
  it("groupBy keeps first-seen group order, null key gives one group", () => {
    expect(groupBy([1, 2, 3, 4], (n) => (n % 2 ? "odd" : "even"))).toEqual([
      ["odd", [1, 3]],
      ["even", [2, 4]],
    ]);
    expect(groupBy([1], null)).toEqual([["", [1]]]);
  });
  it("relTime counts minutes, hours and days back from now", () => {
    expect(relTime("2026-11-21T11:59:50Z", NOW, "en")).toBe("1 min. ago");
    expect(relTime("2026-11-21T10:00:00Z", NOW, "en")).toBe("2 hr. ago");
    expect(relTime("2026-11-18T12:00:00Z", NOW, "de")).toBe("vor 3 Tagen");
  });
  it("lineDiff lists added and removed non-empty lines", () => {
    expect(lineDiff("a\nb", "a\nc")).toEqual({ added: ["c"], removed: ["b"] });
    expect(lineDiff("a\n\n", "a")).toEqual({ added: [], removed: [] });
  });
});

describe("inbox entries", () => {
  it("maps capture, note and session origins to browser, note and assistant", () => {
    expect(entryOrigin({ origin: "capture" })).toBe("browser");
    expect(entryOrigin({ origin: "restored_draft" })).toBe("browser");
    expect(entryOrigin({ origin: "note" })).toBe("note");
    expect(entryOrigin({ origin: "session" })).toBe("assistant");
  });
  it("shows the page host as the source of a browser capture", () => {
    const e = entryView(item(), []);
    expect(e.from).toBe("talks.example.com");
    expect(e.url).toBe("https://talks.example.com/incident");
    expect(e.status).toBe("collected");
    expect(e.state).toBe("collected");
    expect(e.source).toBe("clip");
  });
  it("keeps the server state and origin so old filter links still match", () => {
    expect(entryView(item({ state: "discarded" }), []).state).toBe("discarded");
    expect(entryView(item({ state: "discarded" }), []).status).toBe("rejected");
  });
  it("finds the newest open proposal that covers the item", () => {
    const s = suggestionFor("i-1", [
      proposal({ id: "old", updated_at: "2026-11-20T00:00:00Z" }),
      proposal(),
      proposal({ id: "gone", status: "rejected" }),
    ]);
    expect(s?.proposalId).toBe("p-1");
    expect(s?.kind).toBe("source");
    expect(s?.tags).toEqual(["preise"]);
    expect(suggestionFor("other", [proposal()])).toBeNull();
  });
  it("a skill proposal suggests a skill with the new skill's tags", () => {
    const s = suggestionFor("i-1", [
      proposal(
        {},
        {
          skill: {
            new: { title: "Regeln", scope: "global", tags: ["betrieb"], category: "ops" },
            supersedes: [],
          },
        },
      ),
    ]);
    expect(s?.kind).toBe("skill");
    expect(s?.tags).toEqual(["betrieb"]);
  });
  it("an admitted entry links to its result and has no suggestion", () => {
    const e = entryView(
      item({ state: "admitted", admitted_target_kind: "knowledge", admitted_target_id: "k-1" }),
      [proposal()],
    );
    expect(e.status).toBe("accepted");
    expect(e.result).toEqual({ kind: "source", id: "k-1" });
    expect(e.suggestion).toBeNull();
    expect(isOpenEntry(e)).toBe(false);
  });
  it("strip: accepted offers the result, review offers the review tab, rejected nothing", () => {
    expect(entryStrip({ status: "accepted", result: { kind: "skill", id: "s" } })).toEqual({
      tone: "success",
      key: "accepted",
      action: "openResult",
    });
    expect(entryStrip({ status: "review", result: null }).action).toBe("review");
    expect(entryStrip({ status: "rejected", result: null })).toEqual({
      tone: "neutral",
      key: "rejected",
      action: null,
    });
    expect(entryStrip({ status: "collected", result: null }).tone).toBe("info");
  });
});

describe("inbox attachments", () => {
  it("reads a file attachment and its kind", () => {
    const a = entryAttachment({
      attachment: {
        file_id: "f1",
        filename: "Angebot.PDF",
        content_type: "application/pdf",
        size_bytes: 2048,
        status: "ready",
        reference: "@attachment:angebot",
      },
    });
    expect(a).toEqual({ fileId: "f1", name: "Angebot.PDF", kind: "pdf", size: 2048, ready: true });
  });
  it("is null without an attachment or with a malformed one", () => {
    expect(entryAttachment({ attachment: null })).toBeNull();
    expect(entryAttachment({})).toBeNull();
    expect(entryAttachment({ attachment: { filename: "x.png" } })).toBeNull();
  });
  it("a file still being scanned is not ready", () => {
    expect(
      entryAttachment({ attachment: { file_id: "f", filename: "a.png", status: "scanning" } })
        ?.ready,
    ).toBe(false);
  });
  it("entry view carries the attachment", () => {
    expect(
      entryView(
        { ...item(), attachment: { file_id: "f", filename: "a.csv", size_bytes: 1 } } as never,
        [],
      ).attachment?.kind,
    ).toBe("csv");
  });
});

describe("sources and skills", () => {
  it("source kinds come from the source type", () => {
    expect(sourceKindOf("url", null)).toBe("url");
    expect(sourceKindOf("inline", "text/markdown")).toBe("text");
    expect(sourceKindOf("upload", "application/vnd.oai.openapi+json")).toBe("api");
    expect(sourceKindOf("bundle", null)).toBe("collection");
    expect(sourceKindOf("upload", "application/pdf")).toBe("file");
  });
  it("source status maps processing to ingesting and inactive to off", () => {
    const base = {
      id: "s",
      tenant_id: "t",
      name: "Handbuch",
      slug: "h",
      description: null,
      description_source: "human",
      category: "ops",
      category_source: "human",
      tags: [],
      scope: "global",
      workflow_id: null,
      last_error: null,
      source_type: "url",
      source_uri: "https://docs.example.com",
      mime_type: null,
      version: "1",
      bytes_total: 1,
      chunk_count: 5,
      refresh_strategy: "scheduled",
      refresh_cron: "0 6 * * 1",
      last_refreshed_at: null,
      created_at: "c",
      updated_at: "u",
      status: "active",
    } as components["schemas"]["KnowledgeSource"];
    expect(sourceView({ ...base, status: "processing" }).status).toBe("ingesting");
    const v = sourceView({ ...base, status: "inactive" });
    expect(v).toMatchObject({
      status: "off",
      url: "https://docs.example.com",
      sections: 5,
      ingested: "u",
      scheduled: true,
    });
  });
  it("skill applies_to authoring is shown as workflow drafts, archived as off", () => {
    const v = skillView({
      id: "k",
      title: "Ton",
      status: "archived",
      applies_to: "authoring",
      scope: "global",
      category: "writing",
      version: 3,
      body: "# Ton",
      updated_at: "u",
      created_at: "c",
    } as components["schemas"]["Skill"]);
    expect(v).toMatchObject({ name: "Ton", status: "off", scope: "drafts", version: 3 });
  });
  it("a skill draft needs a name and a rule that is not only a heading", () => {
    expect(skillDraftErrors({ name: " ", body: "# Titel" })).toEqual({ name: true, body: true });
    expect(skillDraftErrors({ name: "Ton", body: "# Titel\n\n- Kurz" })).toEqual({
      name: false,
      body: false,
    });
  });
});

describe("files and uploads", () => {
  it("file kinds follow the extension", () => {
    expect(["a.png", "b.PDF", "c.csv", "d.md", "e.json", "noext"].map(fileKindOf)).toEqual([
      "image",
      "pdf",
      "csv",
      "md",
      "text",
      "text",
    ]);
    expect(extOf("x.tar.gz")).toBe("gz");
  });
  it("file view keeps the server reference as it is", () => {
    const v = fileView({
      id: "f",
      status: "ready",
      filename: "a.csv",
      size_bytes: 1,
      sha256: null,
      creator_name: null,
      created_at: "c",
      updated_at: "u",
      version: 1,
      slug: "a",
      reference: "@attachment:a",
    } as unknown as Parameters<typeof fileView>[0]);
    expect(v.reference).toBe("@attachment:a");
  });
  it("file view carries reference, size, uploader and use count", () => {
    const v = fileView({
      id: "f",
      status: "ready",
      filename: "angebot.pdf",
      content_type: "application/pdf",
      size_bytes: 240_000,
      sha256: "4f2a00000000009c1e",
      scan_result: null,
      created_by: null,
      creator: null,
      creator_name: "Mike Bild",
      created_at: "c",
      updated_at: "u",
      replaced_at: null,
      version: 2,
      deleted_at: null,
      slug: "angebot",
      reference: null,
      description: null,
      description_source: "human",
      category: "sales",
      category_source: "human",
      usage: { workflows: 1, conversations: 0 },
    } as unknown as Parameters<typeof fileView>[0]);
    expect(v).toMatchObject({
      kind: "pdf",
      reference: "@attachment:angebot",
      by: "Mike Bild",
      usedBy: 1,
      checksum: "sha256:4f2a…9c1e",
      ready: true,
    });
  });
  it("fileSize shows KB below a megabyte and one decimal above", () => {
    expect(fileSize(240_000, "de")).toBe("240 KB");
    expect(fileSize(1_200_000, "de")).toBe("1,2 MB");
    expect(fileSize(1_200_000, "en")).toBe("1.2 MB");
  });
  it("rejects files over 5 MB", () => {
    expect(checkUploads([{ name: "x", size: MAX_FILE + 1, hash: "h" }], [])[0]).toEqual({
      ok: false,
      reason: "tooBig",
    });
    expect(checkUploads([{ name: "x", size: MAX_FILE, hash: "h" }], [])[0]).toEqual({ ok: true });
  });
  it("rejects identical content against stored files and within the batch", () => {
    const r = checkUploads(
      [
        { name: "a", size: 1, hash: "same" },
        { name: "b", size: 1, hash: "same" },
        { name: "c", size: 1, hash: "old" },
      ],
      ["old"],
    );
    expect(r.map((x) => x.ok)).toEqual([true, false, false]);
  });
  it("parses CSV with comma or semicolon and strips quotes", () => {
    expect(parseCsv('Datum;Kunde\n"2026-11-01",Harmoniqs\n\n')).toEqual([
      ["Datum", "Kunde"],
      ["2026-11-01", "Harmoniqs"],
    ]);
  });
});

describe("Wohin damit?", () => {
  it("one placed item opens directly, several open the list, chat opens a new chat", () => {
    expect(dropTarget("file", ["f1"])).toBe("/files/f1");
    expect(dropTarget("source", ["a", "b"])).toBe("/knowledge");
    expect(dropTarget("inbox", ["i"])).toBe("/intake/i");
    expect(dropTarget("chat", ["x"])).toBe("/chat/new");
  });
});

describe("restored knowledge functions", () => {
  it("counts only assistant entries that still wait for review", () => {
    expect(
      awaitingAssistantReview([
        { source: "session", state: "collected" },
        { source: "session", state: "reviewing" },
        { source: "session", state: "admitted" },
        { source: "clip", state: "collected" },
      ]),
    ).toBe(2);
  });

  it("a failed address retries, every other failed source goes to the chat", () => {
    expect(failedSourceRemedy("refresh", { write: true, chat: true })).toBe("retry");
    expect(failedSourceRemedy("refresh", { write: false, chat: true })).toBe("chat");
    expect(failedSourceRemedy("edit", { write: true, chat: true })).toBe("chat");
    expect(failedSourceRemedy(null, { write: true, chat: false })).toBeNull();
  });

  it("counts unsaved skill changes field by field", () => {
    const initial = { name: "Tone", body: "Be brief.", scope: "both" };
    expect(skillDraftChanges(initial, initial)).toBe(0);
    expect(skillDraftChanges({ ...initial, body: "Be kind.", scope: "chat" }, initial)).toBe(2);
  });

  it("removes one upload and previews the chosen one", () => {
    const queue = [
      { key: "a", progress: 1 },
      { key: "b", progress: 0 },
    ];
    expect(dropQueued(queue, "a")).toEqual([{ key: "b", progress: 0 }]);
    expect(previewedUpload(queue, "b")).toEqual({ key: "b", progress: 0 });
    expect(previewedUpload(queue, null)).toBeNull();
  });
});

describe("section deep link", () => {
  const endpoint = { key: "get /a", method: "GET", path: "/a", purpose: "", operation: { x: 1 } };
  const section = { key: "s1", title: "Intro", content: "Hi", bytes: 2 };

  it("resolves the key as an endpoint first, then as a section", () => {
    expect(sectionTarget("get /a", [endpoint], [section])).toEqual({ kind: "endpoint", endpoint });
    expect(sectionTarget("s1", [endpoint], [section])).toEqual({ kind: "section", section });
    expect(sectionTarget("gone", [endpoint], [section])).toBeNull();
    expect(sectionTarget("", [endpoint], [section])).toBeNull();
  });
});
