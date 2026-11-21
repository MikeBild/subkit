import { AppMark } from "@ui/atoms/app-mark";
import { FooterSlot } from "@ui/molecules/step-footer";
import { type ReactNode, useState } from "react";

export function OnboardingFrame({
  brand,
  actions,
  dots,
  children,
  foot,
}: {
  brand: string;
  actions?: ReactNode;
  dots?: ReactNode;
  children: ReactNode;
  foot?: ReactNode;
}) {
  const [footer, setFooter] = useState<HTMLDivElement | null>(null);
  return (
    <FooterSlot.Provider value={footer}>
      <div className="onboarding-frame flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden text-base">
        <header className="relative z-10 shrink-0 bg-background px-4 pt-2">
          <div className="mx-auto flex min-h-10 w-full max-w-[640px] items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-heading font-semibold">
              <AppMark size="sm" />
              {brand}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>
          </div>
          <div className="mt-1">{dots}</div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <div className="onboarding-column mx-auto w-full max-w-[640px] min-w-0">{children}</div>
        </main>
        <div className="shrink-0 border-t px-4 pt-3 pb-2">
          <div ref={setFooter} className="mx-auto w-full max-w-[640px]" />
          {foot && (
            <p className="mx-auto mt-1 w-full max-w-[640px] text-center text-xs text-muted-foreground">
              {foot}
            </p>
          )}
        </div>
      </div>
    </FooterSlot.Provider>
  );
}
