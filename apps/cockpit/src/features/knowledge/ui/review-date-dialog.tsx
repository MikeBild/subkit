import { useEffect, useState } from "react";
import { TextField } from "@/components/cockpit/form-field";
import { FormDialog } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { reviewDateBody, reviewDateInput } from "../model/review-date";

export function ReviewDateDialog({
  name,
  current,
  open,
  pending,
  onOpenChange,
  onSave,
}: {
  name: string;
  current: string | null;
  open: boolean;
  pending: boolean;
  onOpenChange(open: boolean): void;
  onSave(review_due_at: string | null): void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(reviewDateInput(current));
  useEffect(() => {
    if (open) setValue(reviewDateInput(current));
  }, [current, open]);
  const body = reviewDateBody(value);
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("kn.sources.reviewTitle", { name })}
      submit={{
        label: t("common.save"),
        disabled: pending || body === undefined || body === current,
        testId: "kn-sources-review-save",
      }}
      onSubmit={() => {
        if (body !== undefined) onSave(body);
      }}
      testId="kn-sources-review-dialog"
    >
      <TextField
        id="kn-sources-review-date"
        type="date"
        label={t("kn.sources.reviewLabel")}
        help={t("kn.sources.reviewHelp")}
        value={value}
        onChange={setValue}
      />
    </FormDialog>
  );
}
