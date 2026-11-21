import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiCall } from "@/api/call";
import { useSetup } from "@/api/setup";
import { useSession } from "@/app/session";
import { useAttention } from "@/app/use-attention";
import {
  joinNames,
  missingConnectors,
  solutionNeeds,
  solutionText,
} from "@/components/cockpit/create-template-model";
import { chipClass } from "@/components/cockpit/patterns";
import { firstJobStarter } from "@/features/setup";
import { LOCALE_TAGS } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";
import { useWorkflowCategories } from "@/queries/mention-sources";
import {
  chatStarters,
  MAX_STARTERS,
  retryStarterQuery,
  starterChips,
  starterGates,
} from "./chat-start-model";

const CHIP = cn(
  chipClass("sm"),
  "h-auto min-h-10 px-3 py-2 text-left hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
);

export function ChatStart({ onPick }: { onPick(prompt: string): void }) {
  const { t, locale } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const permissions = useSession().permissions;
  const gates = starterGates(permissions);
  const setup = useSetup().data;
  const attention = useAttention(permissions);
  const catalog = useWorkflowCategories(gates.workflows);
  const solutions = useQuery({
    queryKey: ["recipe-packs", "solutions"],
    enabled: gates.solutions,
    staleTime: 300_000,
    retry: retryStarterQuery,
    queryFn: () =>
      apiCall("get", "/v1/recipe-packs/{vertical}", { path: { vertical: "solutions" } }),
  });
  const intake = useQuery({
    queryKey: ["chat", "starter-intake"],
    enabled: gates.intake,
    staleTime: 30_000,
    retry: retryStarterQuery,
    queryFn: async () => {
      const [defaultCategory, catalog] = await Promise.all([
        apiCall("get", "/v1/intake/default-category", {}),
        apiCall("get", "/v1/categories", {}),
      ]);
      const usage = catalog.categories.find((entry) => entry.category === defaultCategory.category);
      return { category: defaultCategory.category, collected: usage?.intake_open.collected ?? 0 };
    },
  });
  const knowledge = useQuery({
    queryKey: ["chat", "starter-knowledge"],
    enabled: gates.knowledge,
    staleTime: 300_000,
    retry: retryStarterQuery,
    queryFn: () => apiCall("get", "/v1/knowledge-sources", { query: { limit: 20 } }),
  });
  if ((attention.enabled && attention.query.isLoading) || catalog.isLoading || intake.isLoading)
    return null;
  const tag = LOCALE_TAGS[locale];
  const starters = chatStarters(
    {
      attention: attention.query.data?.items ?? [],
      usage: gates.usage,
      solutions: (solutions.data?.recipes ?? []).map((entry) => {
        const text = solutionText(entry, t);
        return {
          slug: entry.recipe_slug,
          title: text.title,
          line: text.line,
          needs: joinNames(solutionNeeds(entry), tag),
          ready: missingConnectors(entry).length === 0,
        };
      }),
      knowledge: knowledge.data?.items ?? [],
      categories: catalog.categories,
      intake: intake.data ?? null,
    },
    t,
  );
  const firstJob = firstJobStarter(setup, t);
  const all = firstJob ? [firstJob, ...starters].slice(0, MAX_STARTERS) : starters;
  const chips = starterChips(all, expanded);
  return (
    <fieldset className="mb-2 flex flex-wrap gap-2" data-testid="chat-starters">
      <legend className="sr-only">{t("chat.start.chips")}</legend>
      {chips.shown.map((starter) => (
        <button
          key={starter.id}
          type="button"
          className={CHIP}
          title={starter.line}
          onClick={() => onPick(starter.prompt)}
          data-testid={`chat-starter-${starter.id}`}
        >
          {starter.title}
        </button>
      ))}
      {chips.hidden > 0 ? (
        <button
          type="button"
          className={cn(CHIP, "text-muted-foreground")}
          aria-expanded={false}
          onClick={() => setExpanded(true)}
          data-testid="chat-starters-more"
        >
          {t("chat.start.more", { count: chips.hidden })}
        </button>
      ) : null}
    </fieldset>
  );
}
