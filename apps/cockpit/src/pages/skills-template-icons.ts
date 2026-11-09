import { Building2, ClipboardList, LifeBuoy, type LucideIcon, PenLine } from "lucide-react";
import type { SkillTemplate } from "./skills-model";

export const TEMPLATE_ICONS: Record<SkillTemplate, LucideIcon> = {
  tone: PenLine,
  report: ClipboardList,
  errors: LifeBuoy,
  company: Building2,
};
