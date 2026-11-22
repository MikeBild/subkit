import { Braces, File, FileText, Globe, Layers, type LucideIcon } from "lucide-react";
import type { SourceKindView } from "@/features/knowledge/model/knowledge";

export const SOURCE_KIND_ICON: Record<SourceKindView, LucideIcon> = {
  url: Globe,
  file: File,
  text: FileText,
  collection: Layers,
  api: Braces,
};
