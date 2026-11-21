import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@ui/molecules/dropdown-menu";
import { BellOff, BellRing } from "lucide-react";
import { PAUSE_OPTION_KEYS, PAUSE_OPTIONS, usePauseControl } from "@/features/settings";
import { useI18n } from "@/lib/i18n-context";

export function PauseMenu() {
  const { t } = useI18n();
  const control = usePauseControl();
  if (!control.loaded) return null;
  if (control.label)
    return (
      <DropdownMenuItem
        disabled={control.busy}
        onSelect={control.resume}
        data-testid="account-pause-resume"
      >
        <BellRing data-icon="inline-start" />
        <span className="grid min-w-0">
          <span>{t("pause.resume")}</span>
          <span
            className="truncate text-xs font-normal text-muted-foreground"
            data-testid="account-pause-state"
          >
            {control.label}
          </span>
        </span>
      </DropdownMenuItem>
    );
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-testid="account-pause-menu">
        <BellOff data-icon="inline-start" />
        {t("pause.label")}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent data-testid="account-pause-content">
        {PAUSE_OPTIONS.map((option) => (
          <DropdownMenuItem
            key={option}
            disabled={control.busy}
            onSelect={() => control.pause(option)}
            data-testid={`account-pause-${option}`}
          >
            {t(PAUSE_OPTION_KEYS[option])}
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
