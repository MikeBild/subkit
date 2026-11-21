import { Button } from "@ui/atoms/button";
import { Popover, PopoverContent, PopoverTrigger } from "@ui/molecules/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@ui/organisms/command";
import { ChevronsUpDown } from "lucide-react";
import { useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n-context";
import { matchingTimeZones, timeZoneLabel, timeZones } from "@/lib/timezones";

export function TimezoneSelect({
  id,
  value,
  onChange,
  label,
  disabled = false,
  invalid = false,
  describedBy,
  testId,
}: {
  id?: string;
  value: string;
  onChange(value: string): void;
  label: string;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  testId: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const zones = useMemo(() => timeZones(value || null), [value]);
  const shown = useMemo(() => matchingTimeZones(zones, search), [zones, search]);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={label}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          disabled={disabled}
          className="w-full justify-between font-normal"
          data-slot="timezone-select"
          data-testid={testId}
        >
          <span className="truncate">{value ? timeZoneLabel(value) : label}</span>
          <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) min-w-64 p-0"
        data-testid={`${testId}-list`}
      >
        <Command shouldFilter={false}>
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder={t("timezone.search")}
            aria-label={t("timezone.search")}
            data-testid={`${testId}-search`}
          />
          <CommandList className="max-h-64">
            <CommandEmpty data-testid={`${testId}-empty`}>{t("timezone.none")}</CommandEmpty>
            {shown.map((zone) => (
              <CommandItem
                key={zone}
                value={zone}
                data-testid={`${testId}-option`}
                data-zone={zone}
                data-checked={zone === value}
                onSelect={() => {
                  onChange(zone);
                  setOpen(false);
                  setSearch("");
                }}
              >
                <span className="min-w-0 flex-1 truncate">{timeZoneLabel(zone)}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
