import {
  Bell,
  Building2,
  Check,
  ClipboardCheck,
  type LucideIcon,
  MessageSquare,
  ShieldCheck,
} from "lucide-react";
import { useState } from "react";
import type { MessageKey } from "../../../shared/i18n.ts";
import type { WorkspaceOption } from "../../../shared/onboarding.ts";
import { useSignIn } from "../../adapter/index.ts";
import type { ConsentTopic, Screen } from "../../domain/index.ts";
import {
  BusyButton,
  Button,
  FieldError,
  Input,
  Label,
  StepFooter,
  SubKitMark,
  ToggleGroup,
  ToggleGroupItem,
} from "../../ui/index.ts";

type Kind = "welcome" | "invite" | "workspace" | "consent";

const ROLE_KEYS: Readonly<Record<string, MessageKey>> = {
  admin: "firstRun.role.admin",
  member: "firstRun.role.member",
  enduser: "firstRun.role.enduser",
};

export function workspaceLine(workspace: WorkspaceOption, t: (key: MessageKey) => string): string {
  const key = ROLE_KEYS[workspace.role];
  const role = key ? t(key) : workspace.role;
  return role ? `${workspace.name} · ${role}` : workspace.name;
}

function useFirstRunStep<K extends Kind>(kind: K): Extract<Screen, { kind: K }> {
  const { view } = useSignIn();
  const screen = view?.screen;
  if (screen?.kind !== kind) throw new Error(`The ${kind} screen is not shown`);
  return screen as Extract<Screen, { kind: K }>;
}

const FEATURES: readonly { icon: LucideIcon; title: MessageKey; detail: MessageKey }[] = [
  { icon: Bell, title: "welcome.approvals", detail: "welcome.approvals.detail" },
  { icon: MessageSquare, title: "welcome.chat", detail: "welcome.chat.detail" },
  { icon: ClipboardCheck, title: "welcome.tasks", detail: "welcome.tasks.detail" },
  { icon: ShieldCheck, title: "welcome.control", detail: "welcome.control.detail" },
];

export function Welcome() {
  const { invite } = useFirstRunStep("welcome");
  const { t, dispatch } = useSignIn();
  return (
    <div className="text-center">
      <div className="mb-4 flex justify-center">
        <SubKitMark size="lg" />
      </div>
      <h1 className="text-2xl font-semibold">{t("welcome.title")}</h1>
      {invite.open ? (
        <div className="h-6" />
      ) : (
        <ul className="my-6 grid gap-4 text-left min-[480px]:grid-cols-2">
          {FEATURES.map(({ icon: Icon, title, detail }) => (
            <li key={title} className="flex gap-3">
              <Icon className="mt-0.5 size-5 shrink-0 text-info-ink" aria-hidden />
              <div>
                <p className="font-semibold">{t(title)}</p>
                <p className="mt-1 text-sm text-muted-foreground">{t(detail)}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Button
        data-testid="welcome-start"
        className="w-full"
        onClick={() => dispatch({ type: "StartConnect" })}
      >
        {t("welcome.start")}
      </Button>
      <Button
        data-testid="welcome-invite"
        variant="link"
        className="mt-1"
        aria-expanded={invite.open}
        aria-controls="invitation"
        onClick={() => dispatch({ type: "ToggleInvite" })}
      >
        {t("welcome.invite")}
      </Button>
      {invite.open && (
        <form
          id="invitation"
          className="mt-2 text-left"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            dispatch({ type: "OpenInvite" });
          }}
        >
          <Label htmlFor="invitation-link">{t("welcome.invite.label")}</Label>
          <Input
            data-testid="welcome-invite-link"
            id="invitation-link"
            className="mt-2 font-mono"
            value={invite.link}
            inputMode="url"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-invalid={invite.error !== null}
            aria-describedby={invite.error ? "invitation-error" : "invitation-hint"}
            onChange={(e) => dispatch({ type: "EditInvite", link: e.target.value })}
          />
          {invite.error ? (
            <FieldError id="invitation-error" testId="welcome-invite-error">
              {t(invite.error)}
            </FieldError>
          ) : (
            <p id="invitation-hint" className="mt-2 text-xs text-muted-foreground">
              {t("welcome.invite.hint")}
            </p>
          )}
          <BusyButton
            data-testid="welcome-invite-open"
            type="submit"
            className="mt-3"
            busy={invite.checking}
            busyLabel={t("connect.checking")}
          >
            {t("welcome.invite.open")}
          </BusyButton>
        </form>
      )}
    </div>
  );
}

export function Invitation() {
  const { invite } = useFirstRunStep("invite");
  const { t, dispatch } = useSignIn();
  return (
    <div>
      <h1 className="text-2xl font-semibold">{t(invite.title)}</h1>
      <p className="mt-2">{t(invite.body, invite.vars)}</p>
      {invite.meta && (
        <p className="mt-2 text-sm text-muted-foreground">
          {t("invite.meta", { email: invite.meta.email, date: invite.meta.until })}
        </p>
      )}
      <p className="mt-2 font-mono text-xs text-muted-foreground">{invite.host}</p>
      <StepFooter
        label={t("invite.join")}
        disabled={!invite.valid}
        next={() => dispatch({ type: "JoinInvite" })}
        back={() => dispatch({ type: "GoBack" })}
        backLabel={t("common.back")}
        nextLabel={t("common.next")}
        testId="invite"
      />
    </div>
  );
}

export function WorkspaceChoice() {
  const s = useFirstRunStep("workspace");
  const { t, dispatch } = useSignIn();
  const [choice, setChoice] = useState("");
  return (
    <div>
      <h1 className="text-2xl font-semibold">{t("firstRun.workspace.title")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {t("firstRun.workspace.lead", { count: s.workspaces.length })}
      </p>
      <fieldset className="mt-4 flex flex-col gap-2" aria-label={t("firstRun.workspace.title")}>
        {s.workspaces.map((workspace) => (
          <Button
            key={workspace.tenantId}
            data-testid={`first-run-workspace-${workspace.tenantId}`}
            variant={choice === workspace.tenantId ? "secondary" : "outline"}
            aria-pressed={choice === workspace.tenantId}
            className="h-auto w-full justify-start whitespace-normal p-4 text-left"
            onClick={() => setChoice(workspace.tenantId)}
          >
            <Building2 className="size-5 shrink-0" aria-hidden />
            <span>{workspaceLine(workspace, t)}</span>
          </Button>
        ))}
      </fieldset>
      {s.failed && (
        <FieldError testId="first-run-workspace-error">{t("firstRun.workspace.failed")}</FieldError>
      )}
      <StepFooter
        skip={s.failed ? () => dispatch({ type: "KeepWorkspace" }) : undefined}
        skipLabel={t("firstRun.workspace.keep")}
        disabled={!choice}
        next={() => dispatch({ type: "ChooseWorkspace", tenantId: choice })}
        backLabel={t("common.back")}
        nextLabel={t("common.next")}
        testId="first-run-workspace"
      />
    </div>
  );
}

export interface ConsentCopy {
  icon: LucideIcon;
  title: MessageKey;
  lead: MessageKey | null;
  body: MessageKey;
  give: MessageKey;
}

export const CONSENT: Readonly<Record<ConsentTopic, ConsentCopy>> = {
  notifications: {
    icon: Bell,
    title: "firstRun.notifications.title",
    lead: null,
    body: "firstRun.notifications.body",
    give: "firstRun.notifications.allow",
  },
  diagnostics: {
    icon: ShieldCheck,
    title: "firstRun.diagnostics.title",
    lead: "firstRun.diagnostics.question",
    body: "firstRun.diagnostics.body",
    give: "firstRun.diagnostics.share",
  },
};

export function Consent() {
  const { topic, choice } = useFirstRunStep("consent");
  const { t, dispatch } = useSignIn();
  const copy = CONSENT[topic];
  const Icon = copy.icon;
  const options = [
    { give: false, label: t("firstRun.later"), id: "off" },
    { give: true, label: t(copy.give), id: "on" },
  ];
  return (
    <div>
      <div className="flex items-center gap-3">
        <Icon className="size-8 shrink-0 text-info-ink" aria-hidden />
        <h1 className="text-2xl font-semibold">{t(copy.title)}</h1>
      </div>
      {copy.lead && <p className="mt-2 text-sm">{t(copy.lead)}</p>}
      <p className={copy.lead ? "mt-1 text-sm text-muted-foreground" : "mt-2 text-sm"}>
        {t(copy.body)}
      </p>
      <ToggleGroup
        type="single"
        variant="outline"
        className="mt-4"
        aria-label={t(copy.title)}
        value={choice === null ? "" : choice ? "on" : "off"}
        onValueChange={(value) => {
          if (value) dispatch({ type: "ChooseConsent", give: value === "on" });
        }}
      >
        {options.map((option) => (
          <ToggleGroupItem
            key={option.id}
            value={option.id}
            data-testid={`first-run-${topic}-${option.id}`}
            className="px-4"
          >
            {choice === option.give && <Check className="size-4" aria-hidden />}
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <StepFooter
        disabled={choice === null}
        next={() => dispatch({ type: "ConfirmConsent" })}
        backLabel={t("common.back")}
        nextLabel={t("common.next")}
        testId={`first-run-${topic}`}
      />
    </div>
  );
}
