import { Search } from "lucide-react";
import type { ReactNode } from "react";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface FilterSelect {
  value: string;
  onChange(value: string): void;
  label: string;
  options: readonly { value: string; label: string }[];
  testId?: string;
}

/** The most selects a filter bar holds (P7). */
export const MAX_FILTER_SELECTS = 2;

/** Search and at most two selects (P7), in a DataTable's toolbar slot. */
export function FilterBar({
  search,
  selects = [],
  segmented,
}: {
  search?: { value: string; onChange(value: string): void; placeholder: string; testId?: string };
  selects?: readonly FilterSelect[];
  segmented?: ReactNode;
}) {
  return (
    <div data-slot="filter-bar" className="flex w-full flex-wrap items-center gap-2">
      {search ? (
        <InputGroup className="w-full sm:max-w-xs">
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
      {selects.slice(0, MAX_FILTER_SELECTS).map((select) => (
        <Select key={select.label} value={select.value} onValueChange={select.onChange}>
          <SelectTrigger
            className="w-full sm:w-44"
            aria-label={select.label}
            data-testid={select.testId}
          >
            <SelectValue placeholder={select.label} />
          </SelectTrigger>
          <SelectContent>
            {select.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ))}
      {segmented ? <span className="flex items-center">{segmented}</span> : null}
    </div>
  );
}
