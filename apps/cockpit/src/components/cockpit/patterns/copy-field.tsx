import { Copy } from "lucide-react";
import { toast } from "sonner";
import { IconButton } from "@/components/cockpit/icon-button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { reportFailure } from "@/lib/action-failure";
import { useI18n } from "@/lib/i18n-context";

export function useCopy(): (value: string) => Promise<void> {
  const { t } = useI18n();
  return async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t("pattern.copied"));
    } catch {
      reportFailure(t("common.actionFailed"));
    }
  };
}

export function CopyField({
  value,
  label,
  labelled = false,
  testId,
}: {
  value: string;
  label: string;
  labelled?: boolean;
  testId?: string;
}) {
  const { t } = useI18n();
  const copy = useCopy();
  const field = (
    <InputGroup data-slot="copy-field" data-testid={testId ? `${testId}-field` : undefined}>
      <InputGroupInput
        readOnly
        data-testid={testId}
        value={value}
        aria-label={label}
        className="font-mono text-xs"
        onFocus={(event) => event.currentTarget.select()}
      />
      <InputGroupAddon align="inline-end">
        <IconButton
          label={t("common.copy")}
          size="icon-xs"
          data-testid={`${testId ?? "copy-field"}-copy`}
          onClick={() => void copy(value)}
        >
          <Copy />
        </IconButton>
      </InputGroupAddon>
    </InputGroup>
  );
  if (!labelled) return field;
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-slot="copy-field-labelled">
      <span className="text-[13px] font-medium" data-slot="copy-field-label">
        {label}
      </span>
      {field}
    </div>
  );
}
