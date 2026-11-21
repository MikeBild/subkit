import { cn } from "@ui/lib/utils";

export function EnvChip({
  env,
  label,
  className,
}: {
  env: "test" | "prod";
  label: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-2 rounded-full border px-2 text-xs font-medium",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-2 rounded-full",
          env === "prod" ? "bg-emerald-500" : "bg-muted-foreground/60",
        )}
      />
      {label}
    </span>
  );
}
