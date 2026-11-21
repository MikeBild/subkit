import {
  File,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType2,
  type LucideIcon,
} from "lucide-react";

export const FILE_ICON = {
  image: FileImage,
  pdf: FileType2,
  csv: FileSpreadsheet,
  md: FileText,
  text: File,
} as const satisfies Record<string, LucideIcon>;
