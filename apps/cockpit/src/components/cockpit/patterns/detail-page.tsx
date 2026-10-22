import type { ComponentProps, ReactNode } from "react";
import type { ActionSpec } from "./action-button";
import { Page } from "./page";
import { PageHeader } from "./page-header";
import { type PageTab, PageTabs } from "./page-tabs";
import { StatusStrip } from "./status-strip";

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
  tabs,
  defaultTab,
  loading,
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
  tabs?: readonly PageTab[];
  defaultTab?: string;
  loading?: boolean;
  children?: ReactNode;
}) {
  return (
    <Page
      kind="detail"
      surface="detail"
      scroll="page"
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
          testId={`${testId}-header`}
        />
      }
    >
      <div className="flex flex-col gap-4" data-slot="detail-body">
        {strip ? <StatusStrip testId={`${testId}-strip`} {...strip} /> : null}
        {tabs && tabs.length > 0 ? (
          <PageTabs tabs={tabs} param="tab" testId={`${testId}-tabs`} defaultValue={defaultTab} />
        ) : null}
        {children}
      </div>
    </Page>
  );
}
