import { describe, expect, test } from "bun:test";
import type { RawNode } from "./computer-tree.ts";
import {
  COLUMN_PANEL_FR,
  NOTES_WINDOW,
  OPEN_PANEL_EN,
  SAVE_CHANGES_ALERT,
  SAVE_SHEET_DE,
} from "./file-dialog.fixture.ts";
import {
  FILE_DIALOG_DETAIL,
  FILE_DIALOG_REMEDY,
  fileDialogIn,
  looksLikeFilePanel,
} from "./file-dialog.ts";

const id = (value: string) => ({ kind: "ax_identifier", value });
const ok: RawNode = { role: "button", name: "Go", native_id: id("OKButton") };
const files: RawNode = { role: "browser" };
const side: RawNode = { role: "outline" };

describe("fileDialogIn", () => {
  test("finds the save sheet, the open panel and a column browser panel", () => {
    expect(fileDialogIn(SAVE_SHEET_DE)).toBe(true);
    expect(fileDialogIn(OPEN_PANEL_EN)).toBe(true);
    expect(fileDialogIn(COLUMN_PANEL_FR)).toBe(true);
  });

  test("leaves a save-changes alert and an app with a sidebar alone", () => {
    expect(fileDialogIn(SAVE_CHANGES_ALERT)).toBe(false);
    expect(fileDialogIn(NOTES_WINDOW)).toBe(false);
  });

  test("every container kind is checked, other roots are not", () => {
    for (const role of ["window", "sheet", "dialog"]) {
      expect(
        fileDialogIn({ role: "group", children: [{ role, children: [files, side, ok] }] }),
      ).toBe(true);
    }
    expect(fileDialogIn({ role: "group", children: [files, side, ok] })).toBe(false);
  });

  test("names the remedy", () => {
    expect(FILE_DIALOG_REMEDY).toBe(
      "File dialogs are yours to use; for files SubKit uses the allowed folders.",
    );
    expect(FILE_DIALOG_DETAIL).toBe(
      "File dialogs are yours to use; for files SubKit uses the allowed folders. Nothing was sent.",
    );
  });
});

describe("looksLikeFilePanel", () => {
  test("a save name field alone is enough, by either identifier", () => {
    for (const value of ["saveAsNameTextField", "NSSavePanelNameField"]) {
      expect(
        looksLikeFilePanel({
          role: "sheet",
          children: [{ role: "textfield", native_id: id(value) }],
        }),
      ).toBe(true);
    }
    expect(
      looksLikeFilePanel({
        role: "sheet",
        children: [{ role: "button", native_id: id("saveAsNameTextField") }],
      }),
    ).toBe(false);
  });

  test("any two list views count as file view plus sidebar", () => {
    for (const role of ["outline", "list", "table", "browser", "grid"]) {
      expect(looksLikeFilePanel({ role: "sheet", children: [{ role }, files, ok] })).toBe(true);
    }
    expect(looksLikeFilePanel({ role: "sheet", children: [{ role: "group" }, files, ok] })).toBe(
      false,
    );
  });

  test("a list is a file view by role browser or by its identifier", () => {
    for (const value of ["FileList", "ColumnBrowser", "NSNavView"]) {
      expect(
        looksLikeFilePanel({
          role: "sheet",
          children: [{ role: "table", native_id: id(value) }, side, ok],
        }),
      ).toBe(true);
    }
    expect(
      looksLikeFilePanel({
        role: "sheet",
        children: [{ role: "table", native_id: id("Notes") }, side, ok],
      }),
    ).toBe(false);
    expect(looksLikeFilePanel({ role: "sheet", children: [{ role: "table" }, side, ok] })).toBe(
      false,
    );
    expect(
      looksLikeFilePanel({
        role: "sheet",
        children: [{ role: "group", native_id: id("FileArea") }, side, { role: "list" }, ok],
      }),
    ).toBe(false);
  });

  test("the confirm button is found by identifier or by name", () => {
    for (const value of ["OKButton", "NSOKButton"]) {
      expect(
        looksLikeFilePanel({
          role: "sheet",
          children: [files, side, { role: "button", native_id: id(value) }],
        }),
      ).toBe(true);
    }
    for (const name of [
      "Open",
      "Save",
      "Choose",
      "Öffnen",
      "Sichern",
      "Speichern",
      "Auswählen",
      "Ouvrir",
      "Enregistrer",
    ]) {
      expect(
        looksLikeFilePanel({
          role: "sheet",
          children: [files, side, { role: "button", name: ` ${name} ` }],
        }),
      ).toBe(true);
    }
  });

  test("no confirm button, no panel", () => {
    expect(looksLikeFilePanel({ role: "sheet", children: [files, side, { role: "button" }] })).toBe(
      false,
    );
    expect(
      looksLikeFilePanel({
        role: "sheet",
        children: [files, side, { role: "button", name: "Go" }],
      }),
    ).toBe(false);
    expect(
      looksLikeFilePanel({
        role: "sheet",
        children: [files, side, { role: "statictext", name: "Open" }],
      }),
    ).toBe(false);
    expect(
      looksLikeFilePanel({
        role: "sheet",
        children: [files, side, { role: "statictext", native_id: id("OKButton") }],
      }),
    ).toBe(false);
  });

  test("a file view without a second list is no panel", () => {
    expect(looksLikeFilePanel({ role: "sheet", children: [files, ok] })).toBe(false);
  });
});
