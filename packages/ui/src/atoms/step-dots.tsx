import { cn } from "@ui/lib/utils";

export function StepDots({
  visible = true,
  current,
  total,
  label,
}: {
  visible?: boolean;
  current: number;
  total: number;
  label: string;
}) {
  return (
    <div
      role="img"
      aria-label={label}
      aria-hidden={!visible}
      className={cn("flex items-center justify-center gap-2", !visible && "invisible")}
    >
      {Array.from({ length: total }, (_, index) => (
        <span
          key={index}
          aria-current={index === current ? "step" : undefined}
          className={cn(
            "h-2 rounded-full",
            index === current
              ? "w-6 bg-accent"
              : index < current
                ? "w-2 bg-accent"
                : "w-2 bg-muted-foreground/30",
          )}
        />
      ))}
    </div>
  );
}
