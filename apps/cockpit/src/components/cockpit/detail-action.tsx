import { Bot, KeyRound, SearchCheck, ShieldCheck } from "lucide-react";
import { absolute } from "@/app/links";
import { Button } from "@/components/ui/button";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { type Remedy, remedyFor } from "@/lib/remedy";

type DetailResource = "connectors" | "knowledge" | "skills" | "files";

const ICONS: Record<Remedy["kind"], typeof Bot> = {
  review_repair: ShieldCheck,
  grant: ShieldCheck,
  reauth: KeyRound,
  check_auth: KeyRound,
  open_run: SearchCheck,
  chat: Bot,
};

/** A remedy as the action beside a record's title. */
export function RemedyLink({ remedy }: { remedy: Remedy }) {
  const { t } = useI18n();
  const Icon = ICONS[remedy.kind];
  // On a record's own page the conversation is where the record is changed;
  // "fix it" would presume something is broken.
  const label: TranslationKey = remedy.kind === "chat" ? "detail.changeInChat" : remedy.labelKey;
  return (
    <Button asChild variant="outline">
      <a href={absolute(remedy.href)} data-testid="detail-action">
        <Icon data-icon="inline-start" />
        {t(label)}
      </a>
    </Button>
  );
}

/**
 * The action beside a record's title, chosen by its state — never a fixed
 * chat button that filled its own label in as the question. A workflow has a
 * page of its own (`workflow-page.tsx`): its title carries the page's own
 * actions only, and each state's action stands in the section that shows it.
 */
export function DetailAction({
  resource,
  name,
  permissions,
}: {
  resource: DetailResource;
  name: string;
  permissions: readonly string[];
}) {
  // A connector's acts live where its state does: renewing a sign-in in the
  // sign-in card, switching it on in its state notice. A second trigger
  // beside the title would only scroll to the first.
  if (resource === "connectors" || resource === "files") return null;
  return <RecordChatAction name={name} permissions={permissions} />;
}

function RecordChatAction({ name, permissions }: { name: string; permissions: readonly string[] }) {
  const { t } = useI18n();
  const remedy = remedyFor({
    canRun: false,
    canChat: permissions.includes("conversation:write"),
    prompt: t("detail.changeRecordPrompt", { name }),
  });
  return remedy ? <RemedyLink remedy={remedy} /> : null;
}
