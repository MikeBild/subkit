import { useId } from "react";
import { Switch } from "@/components/ui/switch";

export function SwitchField({
  label,
  help,
  checked,
  onChange,
  disabled = false,
  testId,
}: {
  label: string;
  help?: string;
  checked: boolean;
  onChange(checked: boolean): void;
  disabled?: boolean;
  testId: string;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-3 text-left" data-slot="switch-field">
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-describedby={help ? `${id}-help` : undefined}
        className="mt-0.5"
        data-testid={testId}
      />
      <span className="grid gap-0.5">
        <label className="text-sm font-medium" htmlFor={id}>
          {label}
        </label>
        {help ? (
          <span className="text-xs text-muted-foreground" id={`${id}-help`}>
            {help}
          </span>
        ) : null}
      </span>
    </div>
  );
}
