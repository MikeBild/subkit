import { useRouter } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { absolute } from "@/app/links";
import { IconTile } from "@/components/cockpit/patterns";

export interface UsageCard {
  id: string;
  title: string;
  line?: ReactNode;
  href?: string;
  icon: ReactNode;
  aside?: ReactNode;
}

export function UsageCards({ items, testId }: { items: readonly UsageCard[]; testId?: string }) {
  const router = useRouter();
  if (items.length === 0) return null;
  return (
    <ul className="grid gap-2 sm:grid-cols-2" data-slot="usage-cards" data-testid={testId}>
      {items.map((item) => {
        const body = (
          <>
            <IconTile>{item.icon}</IconTile>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{item.title}</span>
              {item.line ? (
                <span className="block text-xs text-muted-foreground">{item.line}</span>
              ) : null}
            </span>
          </>
        );
        if (!item.href)
          return (
            <li key={item.id}>
              <div
                className="flex h-full items-start gap-3 rounded-lg border p-4"
                data-testid={testId ? `${testId}-${item.id}` : undefined}
              >
                {body}
                {item.aside ?? null}
              </div>
            </li>
          );
        const href = absolute(item.href);
        return (
          <li key={item.id}>
            <a
              href={href}
              onClick={(event) => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
                event.preventDefault();
                router.history.push(href);
              }}
              className="flex h-full items-start gap-3 rounded-lg border p-4 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid={testId ? `${testId}-${item.id}` : undefined}
            >
              {body}
              {item.aside ?? (
                <ChevronRight
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground"
                />
              )}
            </a>
          </li>
        );
      })}
    </ul>
  );
}
