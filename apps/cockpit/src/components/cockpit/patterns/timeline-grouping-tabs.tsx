import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function TimelineGroupingTabs<Value extends string>({
  value,
  onChange,
  options,
}: {
  value: Value;
  onChange(value: Value): void;
  options: readonly { value: Value; label: string }[];
}) {
  return (
    <div className="shrink-0 border-b px-4 sm:px-6" data-testid="audit-group-tabs">
      <div className="overflow-x-auto">
        <Tabs value={value} onValueChange={(next) => onChange(next as Value)}>
          <TabsList variant="line" className="h-9 min-w-max gap-6 rounded-none p-0">
            {options.map((option) => (
              <TabsTrigger
                key={option.value}
                value={option.value}
                className="h-9 flex-none rounded-none px-0 text-sm data-active:after:opacity-100"
                data-testid={`audit-group-${option.value}`}
              >
                {option.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
    </div>
  );
}
