import type { RawNode } from "./computer-tree.ts";

const id = (value: string) => ({ kind: "ax_identifier", value });

export const SAVE_SHEET_DE: RawNode = {
  role: "window",
  name: "Budget.numbers",
  children: [
    { role: "toolbar", children: [{ role: "button", name: "Teilen", ref_id: "@s1:e1" }] },
    {
      role: "sheet",
      children: [
        { role: "statictext", name: "Sichern unter:" },
        {
          role: "textfield",
          name: "Sichern unter:",
          value: "Budget",
          native_id: id("saveAsNameTextField"),
          ref_id: "@s1:e2",
        },
        { role: "combobox", name: "Ort", ref_id: "@s1:e3" },
        { role: "button", name: "Abbrechen", native_id: id("CancelButton"), ref_id: "@s1:e4" },
        { role: "button", name: "Sichern", native_id: id("OKButton"), ref_id: "@s1:e5" },
      ],
    },
  ],
};

export const OPEN_PANEL_EN: RawNode = {
  role: "dialog",
  name: "Open",
  children: [
    {
      role: "group",
      children: [
        {
          role: "scrollarea",
          children: [
            {
              role: "outline",
              native_id: id("NSNavSidebarOutlineView"),
              children: [{ role: "treeitem", name: "Documents", ref_id: "@s2:e1" }],
            },
          ],
        },
        {
          role: "scrollarea",
          children: [
            {
              role: "outline",
              native_id: id("NSNavFileBrowserOutlineView"),
              children: [{ role: "treeitem", name: "Invoices", ref_id: "@s2:e2" }],
            },
          ],
        },
      ],
    },
    { role: "button", name: "Cancel", native_id: id("CancelButton"), ref_id: "@s2:e3" },
    { role: "button", name: "Open", native_id: id("OKButton"), ref_id: "@s2:e4" },
  ],
};

export const COLUMN_PANEL_FR: RawNode = {
  role: "window",
  children: [
    {
      role: "sheet",
      children: [
        { role: "list", children: [{ role: "cell", name: "Bureau" }] },
        {
          role: "browser",
          children: [{ role: "list", children: [{ role: "cell", name: "a.pdf" }] }],
        },
        { role: "button", name: "Ouvrir", ref_id: "@s3:e1" },
      ],
    },
  ],
};

export const SAVE_CHANGES_ALERT: RawNode = {
  role: "window",
  name: "Budget.numbers",
  children: [
    {
      role: "sheet",
      children: [
        { role: "statictext", name: "Do you want to save the changes?" },
        { role: "button", name: "Don't Save", ref_id: "@s4:e1" },
        { role: "button", name: "Cancel", ref_id: "@s4:e2" },
        { role: "button", name: "Save", native_id: id("OKButton"), ref_id: "@s4:e3" },
      ],
    },
  ],
};

export const NOTES_WINDOW: RawNode = {
  role: "window",
  name: "Notes",
  children: [
    {
      role: "outline",
      native_id: id("FolderSidebar"),
      children: [{ role: "treeitem", name: "iCloud" }],
    },
    { role: "table", native_id: id("NoteList"), children: [{ role: "row", name: "Shopping" }] },
    { role: "button", name: "Save", ref_id: "@s5:e1" },
  ],
};
