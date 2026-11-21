import {
  File,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType2,
  type LucideIcon,
} from "lucide-react";
import type { FileKind } from "./file-kinds";

export { extOf, type FileKind, fileKindOf } from "./file-kinds";

export const FILE_ICON: Record<FileKind, LucideIcon> = {
  image: FileImage,
  pdf: FileType2,
  csv: FileSpreadsheet,
  md: FileText,
  text: File,
};

export function fileSize(n: number, lang: "de" | "en") {
  const nf = (x: number, d = 0) =>
    new Intl.NumberFormat(lang === "en" ? "en-GB" : "de-DE", { maximumFractionDigits: d }).format(
      x,
    );
  return n >= 1_000_000 ? `${nf(n / 1_000_000, 1)} MB` : `${nf(Math.round(n / 1000))} KB`;
}
