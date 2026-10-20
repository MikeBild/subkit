import { Search, SlidersHorizontal } from "lucide-react";
import { type ReactNode, useState } from "react";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useI18n } from "@/lib/i18n-context";

export interface FilterSelect {
  value: string;
  onChange(value: string): void;
  label: string;
  options: readonly { value: string; label: string }[];
  testId?: string;
}

export const MAX_FILTER_SELECTS = 4;

function FilterField({ select }: { select: FilterSelect }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-muted-foreground">
      <span>{select.label}</span>
      <Select value={select.value} onValueChange={select.onChange}>
        <SelectTrigger
          className="h-9 w-full text-sm"
          aria-label={select.label}
          data-testid={select.testId}
        >
          <SelectValue placeholder={select.label} />
        </SelectTrigger>
        <SelectContent>
          {select.options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              data-testid={`${select.testId ?? "filter"}-option-${option.value}`}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function FilterBar({
  search,
  selects = [],
  segmented,
  reset,
}: {
  search?: { value: string; onChange(value: string): void; placeholder: string; testId?: string };
  selects?: readonly FilterSelect[];
  segmented?: ReactNode;
  reset?: { label: string; onClick(): void };
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const filters = selects;
  const keyOf = (select: FilterSelect) => select.testId ?? select.label;
  const openFilters = () => {
    setDraft(Object.fromEntries(filters.map((select) => [keyOf(select), select.value])));
    setOpen(true);
  };
  const applyFilters = () => {
    for (const select of filters) {
      const next = draft[keyOf(select)];
      if (next !== undefined && next !== select.value) select.onChange(next);
    }
    setOpen(false);
  };
  return (
    <div data-slot="filter-bar" className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      {search ? (
        <InputGroup className="h-9 w-full sm:max-w-xs">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            value={search.value}
            onChange={(event) => search.onChange(event.target.value)}
            placeholder={search.placeholder}
            aria-label={search.placeholder}
            data-testid={search.testId}
          />
        </InputGroup>
      ) : null}
      {filters.length > 0 ? (
        <>
          <div
            className="hidden min-w-0 flex-1 flex-wrap items-end gap-2 min-[1600px]:flex"
            data-slot="wide-filters"
          >
            {filters.slice(0, MAX_FILTER_SELECTS).map((select) => (
              <div key={select.label} className="min-w-36 max-w-52 flex-1">
                <FilterField select={select} />
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={openFilters}
            aria-haspopup="dialog"
            aria-expanded={open}
            className={`inline-flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-accent ${filters.length > MAX_FILTER_SELECTS ? "" : "min-[1600px]:hidden"}`}
            data-testid="filter-bar-open"
          >
            <SlidersHorizontal className="size-4" />
            {t("common.filters")}
          </button>
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetContent
              side="right"
              className="w-full max-w-full gap-0 sm:max-w-sm"
              closeLabel={t("common.close")}
              data-testid="filter-bar-sheet"
            >
              <SheetHeader className="border-b px-5 py-4">
                <SheetTitle>{t("common.filters")}</SheetTitle>
              </SheetHeader>
              <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-6">
                {filters.map((select) => (
                  <FilterField
                    key={keyOf(select)}
                    select={{
                      ...select,
                      value: draft[keyOf(select)] ?? select.value,
                      onChange: (value) =>
                        setDraft((current) => ({ ...current, [keyOf(select)]: value })),
                    }}
                  />
                ))}
              </div>
              <div className="flex items-center justify-between gap-3 border-t px-5 py-4">
                {reset ? (
                  <button
                    type="button"
                    data-testid="filter-bar-reset"
                    onClick={() => {
                      reset.onClick();
                      setOpen(false);
                    }}
                    className="text-sm text-muted-foreground underline underline-offset-2"
                  >
                    {reset.label}
                  </button>
                ) : (
                  <span />
                )}
                <button
                  type="button"
                  data-testid="filter-bar-apply"
                  onClick={applyFilters}
                  className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
                >
                  {t("common.applyFilters")}
                </button>
              </div>
            </SheetContent>
          </Sheet>
        </>
      ) : null}
      {segmented ? <span className="flex items-center">{segmented}</span> : null}
    </div>
  );
}
