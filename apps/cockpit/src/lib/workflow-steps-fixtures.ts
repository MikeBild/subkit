import { translate } from "@/lib/i18n";
import { readStepDefinition, type StepBlock, stepEssenceText } from "./workflow-steps";

export const UUID = "457df8bc-2fe7-4a44-8dba-0acfa31821c5";

export const de: Parameters<typeof stepEssenceText>[1] = (key, values) =>
  translate("de", key, values);

export const read = (step: Record<string, unknown>) => readStepDefinition(step, 0);

export const essence = (step: Record<string, unknown>, connector: string | null = null) =>
  stepEssenceText(read(step), de, { connector });

export const block = (blocks: readonly StepBlock[], labelKey: StepBlock["labelKey"]) =>
  blocks.find((entry) => entry.labelKey === labelKey);
