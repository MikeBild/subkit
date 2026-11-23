import { randomUUID } from "node:crypto";
import { DEFAULT_SERVER } from "../shared/app-identity.ts";
import type { ReportInput } from "../shared/ipc.ts";
import {
  CLOSED_REPORT,
  deliverReport,
  FEEDBACK_PATH,
  type ReportAnswer,
  type ReportBody,
  type ReportTarget,
  type ReportView,
  reportBody,
  reportOutcome,
  reportPreview,
  reportTarget,
} from "../shared/problem-report.ts";
import { activeProfile, type Profile } from "../shared/profiles.ts";
import { hostOf } from "../shared/server-address.ts";
import { appLog } from "./app-log.ts";
import { diagnosticsBundle, diagnosticsText, saveDiagnostics } from "./diagnostics.ts";
import { checkAddress } from "./server-checks.ts";
import { sendAnonymousReport } from "./server-client.ts";
import type { ShellCore } from "./shell-core.ts";

export class ReportFlow {
  private current: ReportView = CLOSED_REPORT;
  private reportId = randomUUID();

  constructor(
    private readonly core: ShellCore,
    private readonly fallback: string | null = DEFAULT_SERVER,
  ) {}

  view(): ReportView {
    return this.current;
  }

  private profile(): Profile | null {
    return activeProfile(this.core.store.data);
  }

  private async bundle(profile: Profile | null) {
    return diagnosticsBundle(await this.core.profiles.diagnosticsContext(profile));
  }

  private update(patch: Partial<ReportView>): void {
    this.current = { ...this.current, ...patch };
    this.core.render();
  }

  async open(): Promise<void> {
    const { core } = this;
    const profile = this.profile();
    const target = reportTarget(profile, this.fallback);
    this.reportId = randomUUID();
    const preview = await this.bundle(profile)
      .then(reportPreview)
      .catch(() => []);
    this.current = {
      ...CLOSED_REPORT,
      host: target ? hostOf(target.origin) : null,
      signedIn: target?.signedIn ?? false,
      preview,
      ...(target ? {} : { phase: "failed", failure: "no_server" }),
    };
    core.showConnect("report");
  }

  async submit(input: ReportInput): Promise<void> {
    if (this.current.phase === "sending" || this.current.phase === "sent") return;
    const profile = this.profile();
    const target = reportTarget(profile, this.fallback);
    if (!target) return this.update({ phase: "failed", failure: "no_server" });
    this.update({ phase: "sending", failure: null, reference: null, retryAfter: null });
    try {
      const body = reportBody({
        bundle: await this.bundle(profile),
        message: input.message,
        attach: input.attach,
        locale: this.core.locale(),
        reportId: this.reportId,
        deviceId: target.deviceId,
      });
      const outcome = reportOutcome(await this.deliver(target, body));
      if (outcome.ok) {
        appLog.info("report.sent");
        return this.update({ phase: "sent", reference: outcome.reference });
      }
      appLog.warn("report.failed", { failure: outcome.failure });
      this.update({
        phase: "failed",
        failure: outcome.failure,
        reference: outcome.reference,
        retryAfter: outcome.retryAfter,
      });
    } catch (error) {
      this.core.record("report", error);
      this.update({ phase: "failed", failure: "failed" });
    }
  }

  private deliver(target: ReportTarget, body: ReportBody): Promise<ReportAnswer | null> {
    const api = this.core.sessions.workspaceApi();
    return deliverReport(target, body, {
      signed: api ? (signed) => api.send("POST", FEEDBACK_PATH, JSON.stringify(signed)) : null,
      anonymousPath: async (origin) => {
        const check = await checkAddress(origin);
        return {
          reachable: check.result.status !== "unreachable",
          path: check.descriptor?.desktop?.anonymousFeedbackPath ?? null,
        };
      },
      anonymous: sendAnonymousReport,
    });
  }

  async save(): Promise<void> {
    const text = diagnosticsText(await this.core.profiles.diagnosticsContext(this.profile()));
    await saveDiagnostics(this.core.windows.connect(), text);
  }
}
