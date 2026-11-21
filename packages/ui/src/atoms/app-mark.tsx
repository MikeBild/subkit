import { useUi } from "@ui/lib/ui-context";
import { cn } from "@ui/lib/utils";

const markSize = {
  xs: "size-5 rounded-[5px]",
  sm: "size-7 rounded-md",
  md: "size-8 rounded-lg",
  lg: "size-12 rounded-xl",
} as const;
const markGlyph = { xs: "size-3.5", sm: "size-[18px]", md: "size-5", lg: "size-8" } as const;

export function AppMark({
  size = "md",
  className,
}: {
  size?: keyof typeof markSize;
  className?: string | undefined;
}) {
  const { mark: Mark } = useUi();
  return (
    <span
      aria-hidden
      data-slot="app-mark"
      className={cn(
        "inline-flex shrink-0 items-center justify-center bg-foreground text-background",
        markSize[size],
        className,
      )}
    >
      <Mark strokeWidth={2.2} className={markGlyph[size]} />
    </span>
  );
}
