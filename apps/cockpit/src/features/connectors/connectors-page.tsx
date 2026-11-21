import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Panel, Pill } from "@ui/atoms/pill";
import { PageSkeleton } from "@ui/atoms/skeleton";
import { ConnectionGraphic } from "@ui/molecules/connection-graphic";
import { EmptyState } from "@ui/molecules/empty-state";
import { EnvChip } from "@ui/molecules/env-chip";
import { ErrorNotice } from "@ui/molecules/error-notice";
import { PageHeader } from "@ui/molecules/page-header";
import { StatusStrip } from "@ui/molecules/status-strip";
import { Bot, KeyRound, LockKeyhole, Plug, UserRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { apiCall } from "@/api/call";
import { absolute, chatNewHref, connectorHref } from "@/app/links";
import { subscribeLiveFrames } from "@/app/live-events";
import { useSession } from "@/app/session";
import { Button } from "@/components/cockpit/patterns/controls";
import { Screen } from "@/components/cockpit/patterns/screen";
import { SectionHeading } from "@/components/cockpit/patterns/section";
import { ForbiddenState } from "@/components/failure-state";
import { connectorSignIn, signInFailure } from "@/features/connectors/api/connector-sign-in";
import { driverLabel } from "@/features/connectors/model/connector-labels";
import {
  allPages,
  ChatMenu,
  categoryCounts,
  ListSummary,
  NoMatch,
  sortRows,
  Toolbar,
  useLegacySearch,
  useListState,
  usePageMenu,
} from "@/features/knowledge";
import { CreateAction } from "@/features/workflows";
import { humanizeCategory } from "@/features/workflows/model";
import { reportFailure } from "@/lib/action-failure";
import { useI18n } from "@/lib/i18n-context";
import { plural } from "@/lib/plural";
import { namedService } from "@/lib/service-icons";
import { useSearchParamState } from "@/lib/use-search-param-state";
import {
  CONNECTOR_KINDS,
  type ConnectorAttention,
  type ConnectorCard,
  type ConnectorKind,
  connectorCard,
  filterCards,
  groupCards,
  HEALTH_TONE,
  isAttention,
  type SigninFinished,
  signinFinished,
  signinStrip,
  sortCards,
  type TestOutcome,
  testOutcome,
  usageBySlug,
} from "./model/connectors-model";
import { ConnectorOnboarding } from "./ui/connector-onboarding";
import { ServiceIcon, SubKitMark } from "./ui/service-icon";

const METHOD_ICON = { account: UserRound, key: KeyRound, secured: LockKeyhole } as const;
const LIMIT = 200;

type KindFilter = ConnectorKind | "all";
type CardSort = "status" | "name" | "tested";
const isKind = (v: string): v is KindFilter =>
  v === "all" || (CONNECTOR_KINDS as readonly string[]).includes(v);
const isCardSort = (v: string): v is CardSort => v === "status" || v === "name" || v === "tested";
const CARD_SORT: Record<Exclude<CardSort, "status">, (c: ConnectorCard) => string> = {
  name: (c) => c.name,
  tested: (c) => c.lastSync,
};

export function ConnectorsPage() {
  const session = useSession();
  const can = (p: string) => session.permissions.includes(p);
  useLegacySearch("connectors");
  if (!can("connector:read"))
    return (
      <Screen testId="connectors-cards">
        <ForbiddenState />
      </Screen>
    );
  return <ConnectorsScreen />;
}

function ConnectorsScreen() {
  const { t } = useI18n();
  const session = useSession();
  const can = (p: string) => session.permissions.includes(p);
  const connectors = useQuery({
    queryKey: ["catalog", "connectors", "cards"],
    queryFn: () =>
      allPages((offset) => apiCall("get", "/v1/connectors", { query: { limit: LIMIT, offset } })),
  });
  const workflows = useQuery({
    queryKey: ["catalog-workflow-index"],
    enabled: can("workflow:read"),
    queryFn: () => apiCall("get", "/v1/workflows", { query: { limit: LIMIT } }),
  });
  const cards = useMemo(() => {
    const used = usageBySlug(workflows.data?.items ?? []);
    return sortCards(
      (connectors.data?.items ?? []).map((c) => connectorCard(c, used.get(c.slug) ?? 0)),
    );
  }, [connectors.data, workflows.data]);
  const st = useListState();
  const menu = usePageMenu({ pkg: "connector", categories: "connector", category: st.cat });
  const [kind, setKind] = useSearchParamState<KindFilter>("kind", "all", isKind);
  const [health, setHealth] = useSearchParamState<ConnectorAttention>("health", "", isAttention);
  const [order, setOrder] = useSearchParamState<CardSort>("sort", "status", isCardSort);
  const attention = health === "not_ok";
  const filtered = filterCards(cards, {
    q: st.q,
    attention,
    kind,
    category: st.cat,
    createdBy: st.createdBy,
  });
  const shown =
    order === "status"
      ? filtered
      : sortRows(filtered, CARD_SORT[order], order === "tested" ? "desc" : "asc");
  const other = t("catalog.categoryOther");
  const key =
    st.group === "category"
      ? (c: ConnectorCard) => humanizeCategory(c.category, other)
      : st.group === "kind"
        ? (c: ConnectorCard) => (c.kind ? t(`catalog.kind.${c.kind}`) : t("cn.kind.none"))
        : st.group === "status"
          ? (c: ConnectorCard) => t(`cn.health.${c.health}`)
          : null;
  const groups = groupCards(shown, key);
  const client = useQueryClient();
  const [signins, setSignins] = useState<ReadonlyMap<string, SigninFinished>>(new Map());
  useEffect(
    () =>
      subscribeLiveFrames((event, data) => {
        const finished = signinFinished(event, data);
        if (!finished) return;
        setSignins((current) => new Map(current).set(finished.connectorId, finished));
        void client.invalidateQueries({ queryKey: ["catalog", "connectors"] });
      }),
    [client],
  );
  const reset = () => {
    st.reset();
    setKind("all");
    setHealth("");
    setOrder("status");
  };
  const create = can("connector:write") ? (
    <CreateAction kind="connector" canChat={can("conversation:write")} testId="connectors-create" />
  ) : can("conversation:write") ? (
    <Button asChild variant="outline">
      <a
        data-testid="connectors-chat"
        href={absolute(chatNewHref({ prompt: t("resource.connectors.action") }))}
      >
        <Bot className="size-4" aria-hidden />
        {t("resource.connectors.action")}
      </a>
    </Button>
  ) : null;
  return (
    <Screen testId="connectors-cards">
      <PageHeader
        title={t("cn.title")}
        lead={t("cn.lead")}
        actions={
          <div className="flex items-center gap-2">
            <ChatMenu items={menu.items} prompts={[]} />
            {create}
          </div>
        }
      />
      {!connectors.data ? (
        connectors.isError ? (
          <ErrorNotice
            kind="pageFailed"
            rows={[]}
            primary={{ label: t("kn.retry"), onClick: () => void connectors.refetch() }}
          />
        ) : (
          <PageSkeleton shape="list" />
        )
      ) : cards.length === 0 ? (
        can("connector:write") ? (
          <ConnectorOnboarding canChat={can("conversation:write")} />
        ) : (
          <EmptyState icon={Plug} title={t("cn.empty")} />
        )
      ) : (
        <>
          <Toolbar
            st={st}
            groups={["category", "kind", "status"]}
            categories={categoryCounts(cards)}
            createdBy
            onReset={reset}
            filters={[
              {
                label: t("cn.filter"),
                value: health || "all",
                defaultValue: "all",
                onChange: (v) => setHealth(v === "not_ok" ? "not_ok" : ""),
                testId: "cn-filter",
                options: [
                  { value: "all", label: t("kn.groups.all") },
                  { value: "not_ok", label: t("cn.filter.attention") },
                ],
              },
              {
                label: t("catalog.kind"),
                value: kind,
                defaultValue: "all",
                onChange: (v) => setKind(isKind(v) ? v : "all"),
                testId: "cn-kind",
                options: (["all", ...CONNECTOR_KINDS] as KindFilter[]).map((k) => ({
                  value: k,
                  label: k === "all" ? t("kn.groups.all") : t(`catalog.kind.${k}`),
                })),
              },
              {
                label: t("cn.sort"),
                value: order,
                defaultValue: "status",
                onChange: (v) => setOrder(isCardSort(v) ? v : "status"),
                testId: "cn-sort",
                options: (["status", "name", "tested"] as CardSort[]).map((s) => ({
                  value: s,
                  label: t(`cn.sort.${s}`),
                })),
              },
            ]}
          />
          <ListSummary
            testId="cn-summary"
            kind="connector"
            parts={[
              t(
                shown.length === 1
                  ? "resource.connectors.summary.one"
                  : "resource.connectors.summary.other",
                { count: shown.length },
              ),
            ]}
          />
          {shown.length === 0 ? (
            <NoMatch onReset={reset} />
          ) : (
            <div className="flex flex-col gap-6">
              {groups.map(([label, list]) => (
                <section key={label || "all"} aria-label={label || t("cn.title")}>
                  {label && (
                    <SectionHeading className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {label} <span className="font-mono font-normal">· {list.length}</span>
                    </SectionHeading>
                  )}
                  <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,17rem),1fr))] gap-4">
                    {list.map((c) => (
                      <li key={c.id}>
                        <Card
                          c={c}
                          signin={signins.get(c.id)}
                          canTest={can("connector:write") || can("connector:read")}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </>
      )}
      {menu.dialogs}
    </Screen>
  );
}

function Card({
  c,
  canTest,
  signin,
}: {
  c: ConnectorCard;
  canTest: boolean;
  signin?: SigninFinished | undefined;
}) {
  const { t, dateTime } = useI18n();
  const navigate = useNavigate();
  const [tested, setTested] = useState<TestOutcome | null>(null);
  const tone = HEALTH_TONE[c.health];
  const test = useMutation({
    mutationFn: () => apiCall("post", "/v1/connectors/{id}/test", { path: { id: c.id } }),
    onSuccess: (r) => setTested(testOutcome(r, c.health)),
    onError: () => setTested("failed"),
  });
  const signIn = useMutation({
    mutationFn: async (): Promise<{ authorization_url: string } | null> => {
      const route = connectorSignIn(
        await apiCall("get", "/v1/connectors/{id}", { path: { id: c.id } }),
      );
      if (!route) return null;
      return route.kind === "mcp"
        ? apiCall("post", "/v1/connectors/{id}/mcp/authorize", { path: { id: c.id } })
        : apiCall("post", "/v1/connectors/{id}/oauth/start", { path: { id: c.id } });
    },
    onSuccess: (r) => {
      if (r?.authorization_url) window.location.assign(r.authorization_url);
      else void navigate({ to: connectorHref(c.id) });
    },
    onError: (error) => {
      reportFailure(signInFailure(error, t), error);
      void navigate({ to: connectorHref(c.id) });
    },
  });
  return (
    <Panel className="flex h-full flex-col gap-3">
      <button
        data-testid="cn-open"
        type="button"
        className="flex flex-wrap items-center gap-3 rounded-md text-left"
        onClick={() => void navigate({ to: connectorHref(c.id) })}
      >
        <ServiceIcon service={namedService(c.name)} tile="lg" />
        <span className="min-w-[8rem] flex-1">
          <span className="block truncate font-semibold" title={c.name}>
            {c.name}
          </span>
          <span className="block truncate font-mono text-xs text-muted-foreground">
            {c.account}
          </span>
        </span>
        <EnvChip env={c.env} label={t(c.env === "prod" ? "cn.env.prod" : "cn.env.test")} />
      </button>
      {c.health !== "reauth" && (
        <Pill tone={tone} className="self-start">
          {t(`cn.health.${c.health}`)}
        </Pill>
      )}
      {signin && (
        <StatusStrip tone={signinStrip(signin).tone} className="mb-0">
          {t(signinStrip(signin).key)}
          {signin.reason && (
            <span className="font-mono text-xs text-muted-foreground">{signin.reason}</span>
          )}
        </StatusStrip>
      )}
      <ConnectionGraphic
        from={<SubKitMark size="md" />}
        via={METHOD_ICON[c.method]}
        to={<ServiceIcon service={namedService(c.name)} tile="md" />}
        tone={tone}
        state={t(`cn.state.${c.health}`)}
      />
      <p className="text-xs text-muted-foreground" data-testid="cn-meta">
        {[
          driverLabel(c.driver, t),
          c.tools === null
            ? null
            : t(
                c.tools === 1
                  ? "connectorDetail.tools.count.one"
                  : "connectorDetail.tools.count.other",
                {
                  count: c.tools,
                },
              ),
          t("cn.lastSync", { when: dateTime(c.lastSync) }),
          plural(t, "cn.usedBy", c.usedBy),
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <div className="mt-auto">
        {c.health === "reauth" ? (
          <ErrorNotice
            kind="reauth"
            rows={[[t("cn.connector"), c.account]]}
            primary={{ label: t("cn.relogin"), onClick: () => signIn.mutate() }}
          />
        ) : canTest ? (
          <Button
            data-testid="cn-test"
            size="sm"
            variant="outline"
            disabled={test.isPending}
            onClick={() => test.mutate()}
          >
            {t("cn.test")}
          </Button>
        ) : null}
        {tested && c.health !== "reauth" && (
          <p role="status" className="mt-2 text-xs">
            {t(`cn.tested.${tested}`)}
          </p>
        )}
      </div>
    </Panel>
  );
}
