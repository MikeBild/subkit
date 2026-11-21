import { describe, expect, test } from "bun:test";
import {
  clampSidePanelWidth,
  isSidePanelShortcut,
  keyedSidePanelWidth,
  parseSidePanelState,
  resizedSidePanelWidth,
  SIDE_PANEL_DEFAULT,
  SIDE_PANEL_INITIAL,
  serializeSidePanelState,
  shownSidePanelTab,
  sidePanelContextName,
  sidePanelSubject,
  sidePanelTabs,
  technicalFactsPlace,
} from "./side-panel-model";

const ID = "018f4b4a-6d33-7b3a-9c2d-123456789abc";
const key = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };

describe("side panel model", () => {
  test("keeps the width between 320 and 560 px", () => {
    expect(clampSidePanelWidth(100)).toBe(320);
    expect(clampSidePanelWidth(900)).toBe(560);
    expect(clampSidePanelWidth(401.4)).toBe(401);
    expect(clampSidePanelWidth(Number.NaN)).toBe(SIDE_PANEL_DEFAULT);
  });

  test("remembers open state, width and tab and survives broken storage", () => {
    const stored = serializeSidePanelState({ open: true, width: 9999, tab: "history" });
    expect(parseSidePanelState(stored)).toEqual({ open: true, width: 560, tab: "history" });
    expect(parseSidePanelState("{")).toEqual(SIDE_PANEL_INITIAL);
    expect(parseSidePanelState(null)).toEqual(SIDE_PANEL_INITIAL);
    expect(parseSidePanelState('{"open":"yes","tab":"nope"}')).toEqual(SIDE_PANEL_INITIAL);
  });

  test("toggles on Cmd+J and Ctrl+J only", () => {
    expect(isSidePanelShortcut({ ...key, key: "j", metaKey: true })).toBe(true);
    expect(isSidePanelShortcut({ ...key, key: "J", ctrlKey: true })).toBe(true);
    expect(isSidePanelShortcut({ ...key, key: "j" })).toBe(false);
    expect(isSidePanelShortcut({ ...key, key: "j", metaKey: true, shiftKey: true })).toBe(false);
    expect(isSidePanelShortcut({ ...key, key: "b", metaKey: true })).toBe(false);
  });

  test("names the record a detail route shows", () => {
    expect(sidePanelSubject(`/workflows/${ID}`)).toEqual({ type: "workflow", id: ID });
    expect(sidePanelSubject(`/knowledge/${ID}`)).toEqual({ type: "knowledge_source", id: ID });
    expect(sidePanelSubject(`/tasks/${ID}`)).toEqual({ type: "task", id: ID });
    expect(sidePanelSubject("/workflows")).toBeNull();
    expect(sidePanelSubject("/skills/candidates")).toBeNull();
    expect(sidePanelSubject(`/chat/${ID}`)).toBeNull();
  });

  test("hides the chat tab inside the chat and falls back to details", () => {
    expect(sidePanelTabs("/chat/new")).toEqual(["details", "history"]);
    expect(sidePanelTabs("/workflows")).toEqual(["chat", "details", "history"]);
    expect(shownSidePanelTab("chat", sidePanelTabs("/chat"))).toBe("details");
    expect(shownSidePanelTab("history", sidePanelTabs("/chat"))).toBe("history");
  });

  test("technical facts have one place: the Details tab, or inline where a sheet covers the panel", () => {
    expect(technicalFactsPlace({ sidePanel: true, presentation: "page" })).toBe("details");
    expect(technicalFactsPlace({ sidePanel: true, presentation: "docked" })).toBe("details");
    expect(technicalFactsPlace({ sidePanel: true, presentation: "modal" })).toBe("inline");
    for (const presentation of ["page", "docked", "modal"] as const)
      expect(technicalFactsPlace({ sidePanel: false, presentation })).toBe("inline");
  });

  test("resizes by drag towards the left and by arrow keys", () => {
    expect(resizedSidePanelWidth(400, 1000, 960)).toBe(440);
    expect(resizedSidePanelWidth(400, 1000, 1200)).toBe(320);
    expect(keyedSidePanelWidth(400, "ArrowLeft")).toBe(416);
    expect(keyedSidePanelWidth(400, "ArrowRight")).toBe(384);
    expect(keyedSidePanelWidth(400, "Home")).toBe(560);
    expect(keyedSidePanelWidth(400, "Enter")).toBeNull();
  });
});

describe("sidePanelContextName", () => {
  test("names what the page shows: its own title first", () => {
    expect(
      sidePanelContextName({ pageTitle: "Lieferavise zusammenfassen", navLabel: "Workflows" }),
    ).toBe("Lieferavise zusammenfassen");
  });

  test("falls back to the navigation entry while the page has no title yet", () => {
    expect(sidePanelContextName({ pageTitle: null, navLabel: "Übersicht" })).toBe("Übersicht");
    expect(sidePanelContextName({ pageTitle: "  ", navLabel: "Übersicht" })).toBe("Übersicht");
  });

  test("says nothing when neither is known", () => {
    expect(sidePanelContextName({ pageTitle: null, navLabel: null })).toBeNull();
  });
});

describe("file subjects", () => {
  test("a file record keeps its fid_ id so the panel can attach it", () => {
    expect(sidePanelSubject(`/files/fid_${ID}`)).toEqual({ type: "file", id: `fid_${ID}` });
    expect(sidePanelSubject(`/files/${ID}`)).toBeNull();
  });
});
