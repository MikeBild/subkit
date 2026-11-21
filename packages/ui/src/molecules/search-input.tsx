import { cn } from "@ui/lib/utils";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@ui/molecules/input-group";
import { Search } from "lucide-react";

export function SearchInput({
  value,
  onChange,
  label,
  id,
  testId,
  className,
}: {
  value: string;
  onChange(value: string): void;
  label: string;
  id?: string | undefined;
  testId?: string | undefined;
  className?: string | undefined;
}) {
  return (
    <InputGroup data-slot="search-input" className={cn("w-full", className)}>
      <InputGroupAddon>
        <Search />
      </InputGroupAddon>
      <InputGroupInput
        id={id}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={label}
        aria-label={label}
        data-testid={testId}
      />
    </InputGroup>
  );
}
