import { FILE_DIALOG_REFUSAL } from "@shared/device/computer.ts";
import type { RawNode } from "./computer-tree.ts";

const CONTAINERS: ReadonlySet<string> = new Set(["window", "sheet", "dialog"]);
const LISTS: ReadonlySet<string> = new Set(["outline", "list", "table", "browser", "grid"]);
const NAME_FIELD_IDS: ReadonlySet<string | undefined> = new Set([
  "saveasnametextfield",
  "nssavepanelnamefield",
]);
const CONFIRM_IDS: ReadonlySet<string | undefined> = new Set(["okbutton", "nsokbutton"]);
const CONFIRM_NAMES: ReadonlySet<string> = new Set([
  "open",
  "save",
  "choose",
  "öffnen",
  "sichern",
  "speichern",
  "auswählen",
  "ouvrir",
  "enregistrer",
]);
const FILE_VIEW_ID = /file|browser|navview/;

export const FILE_DIALOG_REMEDY =
  "File dialogs are yours to use; for files SubKit uses the allowed folders.";
export const FILE_DIALOG_DETAIL = FILE_DIALOG_REFUSAL.en;

function idOf(node: RawNode): string | undefined {
  return node.native_id?.value.toLowerCase();
}

function nodes(root: RawNode): RawNode[] {
  return [root, ...(root.children ?? []).flatMap(nodes)];
}

function isNameField(node: RawNode): boolean {
  return node.role === "textfield" && NAME_FIELD_IDS.has(idOf(node));
}

function isFileView(node: RawNode): boolean {
  return node.role === "browser" || (LISTS.has(node.role) && FILE_VIEW_ID.test(String(idOf(node))));
}

function isConfirm(node: RawNode): boolean {
  if (node.role !== "button") return false;
  if (CONFIRM_IDS.has(idOf(node))) return true;
  return node.name !== undefined && CONFIRM_NAMES.has(node.name.trim().toLowerCase());
}

export function looksLikeFilePanel(container: RawNode): boolean {
  const inside = nodes(container);
  if (inside.some(isNameField)) return true;
  const lists = inside.filter((node) => LISTS.has(node.role)).length;
  return lists >= 2 && inside.some(isFileView) && inside.some(isConfirm);
}

export function fileDialogIn(tree: RawNode): boolean {
  return nodes(tree).some((node) => CONTAINERS.has(node.role) && looksLikeFilePanel(node));
}
