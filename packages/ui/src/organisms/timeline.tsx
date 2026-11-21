import type { Tone } from "@ui/atoms/pill";
import { StatusDot } from "@ui/atoms/status-dot";
import { cn } from "@ui/lib/utils";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function dayKey(iso: string) {
  return iso.slice(0, 10);
}
export function dayLabel(iso: string, lang: "de" | "en") {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(Date.now() - 86400_000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return lang === "de" ? "Heute" : "Today";
  if (same(d, y)) return lang === "de" ? "Gestern" : "Yesterday";
  return new Intl.DateTimeFormat(lang === "de" ? "de-DE" : "en-US", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(d);
}
export interface TimelineItem {
  id: string;
  at: string;
  tone: Tone;
  icon?: LucideIcon | undefined;
  content: ReactNode;
  highlight?: boolean | undefined;
  ref?: ((el: HTMLLIElement | null) => void) | undefined;
}
export function Timeline({
  items,
  lang,
  time,
}: {
  items: TimelineItem[];
  lang: "de" | "en";
  time: (iso: string) => string;
}) {
  const groups: { key: string; label: string; items: TimelineItem[] }[] = [];
  for (const it of items) {
    const k = dayKey(new Date(it.at).toISOString());
    const g = groups.find((x) => x.key === k);
    if (g) g.items.push(it);
    else groups.push({ key: k, label: dayLabel(it.at, lang), items: [it] });
  }
  return (
    <div className="mt-6 space-y-6">
      {groups.map((g) => (
        <section key={g.key}>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {g.label}
          </h3>
          <ol className="relative space-y-3 before:absolute before:bottom-4 before:left-4 before:top-4 before:w-px before:bg-border">
            {g.items.map((it) => (
              <li
                key={it.id}
                ref={it.ref}
                tabIndex={it.highlight ? -1 : undefined}
                className="relative flex gap-4"
              >
                <span className="relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border bg-background">
                  {it.icon ? (
                    <it.icon className="size-4 text-muted-foreground" aria-hidden />
                  ) : null}
                  <StatusDot
                    tone={it.tone}
                    className={cn(
                      "absolute -right-1 -top-1 ring-2 ring-background",
                      !it.icon && "static ring-0",
                    )}
                  />
                </span>
                <div
                  className={cn(
                    "min-w-0 flex-1 rounded-xl border bg-card p-4",
                    it.highlight && "border-accent ring-2 ring-accent/40",
                  )}
                >
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">{it.content}</div>
                    <time
                      className="shrink-0 font-mono text-xs text-muted-foreground"
                      dateTime={it.at}
                    >
                      {time(it.at)}
                    </time>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
