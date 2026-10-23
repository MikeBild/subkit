import { Search } from "lucide-react";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { cn } from "@/lib/utils";

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
  id?: string;
  testId?: string;
  className?: string;
}) {
  return (
    <InputGroup data-slot="search-input" className={cn("h-9 w-full", className)}>
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
