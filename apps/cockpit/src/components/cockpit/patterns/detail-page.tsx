import { Skeleton } from "@ui/atoms/skeleton";
import type { ComponentProps, ReactNode } from "react";
import { technicalFactsPlace } from "@/app/side-panel-model";
import { useI18n } from "@/lib/i18n-context";
import type { ActionSpec } from "./action-button";
import { ActionFailureHost } from "./action-failure";
import { Page } from "./page";
import { PageHeader } from "./page-header";
import { type PageTab, PageTabs } from "./page-tabs";
import { SideDetails, SideSection, useSideDetailsAvailable } from "./side-details";
import { StatusStrip } from "./status-strip";
import { TechnicalDetails } from "./tab-body";

export type DetailStrip = ComponentProps<typeof StatusStrip>;

export function DetailPage({
  testId,
  back,
  title,
  badge,
  purpose,
  action,
  menu,
  strip,
  status,
  notice,
  tabs,
  defaultTab,
  loading,
  loadingPurpose,
  technical,
  children,
}: {
  testId: string;
  back: { to: string; label: string };
  title: string;
  badge?: ReactNode;
  purpose?: ReactNode;
  action?: ReactNode | ActionSpec;
  menu?: ReactNode;
  strip?: DetailStrip | null;
  status?: ReactNode;
  notice?: ReactNode;
  tabs?: readonly PageTab[];
  defaultTab?: string;
  loading?: boolean;
  loadingPurpose?: boolean;
  technical?: ReactNode;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const side =
    technicalFactsPlace({ sidePanel: useSideDetailsAvailable(), presentation: "page" }) ===
    "details";
  return (
    <Page
      kind="detail"
      surface="detail"
      scroll="page"
      failureHost={false}
      testId={testId}
      header={
        <PageHeader
          back={back}
          title={title}
          badge={badge}
          purpose={purpose}
          action={action}
          menu={menu}
          loading={loading}
          loadingPurpose={loadingPurpose}
          purposeLines={2}
          testId={`${testId}-header`}
        />
      }
    >
      <div className="@container flex flex-col gap-4" data-slot="detail-body">
        {strip ? <StatusStrip testId={`${testId}-strip`} {...strip} /> : status}
        {notice}
        <ActionFailureHost level="page" />
        {tabs && tabs.length > 0 ? (
          <PageTabs tabs={tabs} param="tab" testId={`${testId}-tabs`} defaultValue={defaultTab} />
        ) : null}
        {children}
        {technical && !side ? (
          <TechnicalDetails testId={`${testId}-technical`}>{technical}</TechnicalDetails>
        ) : null}
      </div>
      {side && technical ? (
        <SideDetails>
          <SideSection title={t("sidePanel.details.technical")} testId="side-details-technical">
            {technical}
          </SideSection>
        </SideDetails>
      ) : null}
    </Page>
  );
}

export function DetailPageLoading({
  testId,
  back,
  purpose,
}: {
  testId: string;
  back: { to: string; label: string };
  purpose?: boolean;
}) {
  return (
    <DetailPage
      testId={testId}
      back={back}
      title=""
      loading
      loadingPurpose={purpose}
      strip={{ tone: "info", line: "", loading: true }}
    >
      <Skeleton className="h-9 w-72 max-w-full" />
      <Skeleton className="h-64 w-full" />
    </DetailPage>
  );
}
