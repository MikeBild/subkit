import { Copy } from "lucide-react";
import { toast } from "sonner";
import { IconButton } from "@/components/cockpit/icon-button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { useI18n } from "@/lib/i18n-context";

/** Copy a value and say so. */
export function useCopy(): (value: string) => Promise<void> {
  const { t } = useI18n();
  return async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t("pattern.copied"));
    } catch {
      toast.error(t("common.actionFailed"));
    }
  };
}

/**
 * An address, a key or an id to take elsewhere (P15): the value in mono, and a
 * copy button. `testId` names the value itself (`${testId}-field` the frame,
 * `${testId}-copy` the button), so a check reads the value off its own id.
 */
export function CopyField({
  value,
  label,
  testId,
}: {
  value: string;
  label: string;
  testId?: string;
}) {
  const { t } = useI18n();
  const copy = useCopy();
  return (
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
}
