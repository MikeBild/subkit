import { useI18n } from "@/lib/i18n-context";
import { GroupingTabs } from "./grouping-tabs";

export function TimelineGroupingTabs<Value extends string>({
  value,
  onChange,
  options,
}: {
  value: Value;
  onChange(value: Value): void;
  options: readonly { value: Value; label: string }[];
}) {
  const { t } = useI18n();
  return (
    <GroupingTabs
      label={t("common.groupBy")}
      value={value}
      onChange={(next) => onChange(next as Value)}
      options={options}
      testId="audit-group-tabs"
      itemTestIdPrefix="audit-group"
      className="px-4 sm:px-6"
    />
  );
}
