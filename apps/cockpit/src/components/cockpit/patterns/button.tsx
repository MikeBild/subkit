import { Button as Primitive } from "@ui/atoms/button";
import { cn } from "@ui/lib/utils";
import { Loader2 } from "lucide-react";
import type { ComponentProps } from "react";
import { useI18n } from "@/lib/i18n-context";

export function Button({
  pending,
  disabled,
  className,
  children,
  asChild,
  ...props
}: ComponentProps<typeof Primitive> & { pending?: boolean }) {
  const { t } = useI18n();
  if (asChild)
    return (
      <Primitive {...props} asChild disabled={disabled} className={className}>
        {children}
      </Primitive>
    );
  return (
    <Primitive
      {...props}
      disabled={disabled || pending}
      aria-busy={pending ? true : undefined}
      data-pending={pending ? "true" : undefined}
      className={cn("relative", className)}
    >
      <span
        className={cn("inline-flex min-w-0 items-center gap-[inherit]", pending && "invisible")}
      >
        {children}
      </span>
      {pending ? (
        <span className="absolute inset-0 flex items-center justify-center" role="status">
          <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
          <span className="sr-only">{t("platform.inProgress")}</span>
        </span>
      ) : null}
    </Primitive>
  );
}
