import type { ReactNode } from "react";

export function OnboardingFrame({
  lead,
  children,
  testId,
}: {
  lead: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex flex-col gap-6 pb-6" data-slot="onboarding" data-testid={testId}>
      <p className="max-w-2xl text-sm text-muted-foreground" data-slot="onboarding-lead">
        {lead}
      </p>
      {children}
    </div>
  );
}
