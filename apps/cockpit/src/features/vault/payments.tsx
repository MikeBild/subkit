import { useQueryClient } from "@tanstack/react-query";
import { Panel } from "@ui/atoms/pill";
import { CreditCard } from "lucide-react";
import { useEffect, useMemo, useReducer, useState } from "react";
import { toast } from "sonner";
import { VAULT_KEY, VAULT_PAYMENTS_KEY } from "@/api/vault";
import {
  Button,
  DataState,
  dialogFailure,
  type Fact,
  FactList,
  FormDialog,
  SectionHeading,
} from "@/components/cockpit/patterns";
import {
  cardLabel,
  countdownLabel,
  cvvLength,
  cvvProblem,
  formatMinor,
  PANEL_START,
  type Payment,
  type PendingResume,
  panelStep,
  paymentErrorKey,
  paymentFromUrl,
  paymentView,
  secondsLeft,
} from "@/features/vault/model/payments";
import { useI18n } from "@/lib/i18n-context";
import {
  useApprovePayment,
  usePendingPayments,
  useRejectPayment,
  useResumeChat,
} from "./hooks/use-vault-payments";

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

export function PaymentFacts({ payment, now }: { payment: Payment; now: number }) {
  const { t, locale } = useI18n();
  const left = secondsLeft(payment.expiresAt, now);
  const card = cardLabel(payment);
  const facts: Fact[] = [
    { label: t("vault.payment.shop"), value: <span className="font-mono">{payment.host}</span> },
    {
      label: t("vault.payment.amount"),
      value: (
        <span className="font-semibold tabular-nums" data-testid="vault-payment-amount">
          {formatMinor(locale, payment.amountMinor, payment.currency)}
        </span>
      ),
    },
    ...(card ? [{ label: t("vault.payment.card"), value: card }] : []),
  ];
  return (
    <div className="grid gap-2">
      <FactList items={facts} testId="vault-payment-facts" />
      {left !== null ? (
        <p
          className="text-xs text-muted-foreground tabular-nums"
          data-testid="vault-payment-countdown"
        >
          {left > 0
            ? t("vault.payment.expiresIn", { time: countdownLabel(left) })
            : t("vault.payment.expired")}
        </p>
      ) : null}
    </div>
  );
}

export function CvvInput({
  value,
  brand,
  error,
  disabled,
  onChange,
}: {
  value: string;
  brand: string | null;
  error: string | null;
  disabled: boolean;
  onChange(value: string): void;
}) {
  const { t } = useI18n();
  const max = Math.max(...cvvLength(brand));
  const described = ["vault-payment-cvv-help", error ? "vault-payment-cvv-error" : null]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="grid gap-1.5" data-invalid={error ? true : undefined}>
      <label htmlFor="vault-payment-cvv" className="text-sm font-medium">
        {t("vault.payment.cvv")}
      </label>
      <input
        id="vault-payment-cvv"
        name="vault-payment-cvv"
        type="text"
        inputMode="numeric"
        spellCheck={false}
        autoComplete="off"
        pattern="[0-9]*"
        maxLength={max}
        required
        disabled={disabled}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={described}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 w-28 rounded-md border bg-background px-3 font-mono tracking-widest [-webkit-text-security:disc] outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:h-8"
        data-testid="vault-payment-cvv"
      />
      <p id="vault-payment-cvv-help" className="text-xs text-muted-foreground">
        {t("vault.payment.cvvHelp")}
      </p>
      {error ? (
        <p id="vault-payment-cvv-error" role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function ResumeNotice({
  pending,
  retrying,
  onRetry,
}: {
  pending: PendingResume | null;
  retrying: boolean;
  onRetry(): void;
}) {
  const { t } = useI18n();
  if (!pending) return null;
  return (
    <div className="grid justify-items-start gap-2" data-testid="vault-payment-resume-failed">
      <p role="alert" className="text-sm text-destructive">
        {retrying ? t("vault.payment.resuming") : t("vault.payment.resumeFailed")}
      </p>
      <Button
        type="button"
        size="sm"
        disabled={retrying}
        onClick={onRetry}
        data-testid="vault-payment-resume-retry"
      >
        {t("vault.payment.resumeRetry")}
      </Button>
    </div>
  );
}

export function PaymentApprovalDialog({
  payment,
  missing,
  onClose,
}: {
  payment: Payment | null;
  missing: boolean;
  onClose(): void;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const [state, send] = useReducer(panelStep, PANEL_START);
  const open = payment !== null || missing;
  const now = useNow(payment !== null && state.phase === "idle");
  const approve = useApprovePayment();
  const reject = useRejectPayment();
  const resume = useResumeChat();
  const left = payment ? secondsLeft(payment.expiresAt, now) : null;
  const expired = left === 0;
  const problem = payment ? cvvProblem(state.cvv, payment.brand) : null;
  const settle = () => {
    void client.invalidateQueries({ queryKey: VAULT_PAYMENTS_KEY });
    void client.invalidateQueries({ queryKey: VAULT_KEY });
  };
  const close = () => {
    send({ type: "close" });
    approve.reset();
    reject.reset();
    resume.reset();
    onClose();
  };
  const declined = () => {
    toast.success(t("vault.payment.rejected"));
    close();
  };
  const submit = () => {
    if (!payment || expired) return;
    if (problem) {
      send({ type: "invalid" });
      return;
    }
    const cvv = state.cvv;
    send({ type: "approve" });
    approve.mutate(
      { id: payment.id, cvv },
      {
        onSuccess: (outcome) => {
          approve.reset();
          send({ type: "approved" });
          settle();
          if (outcome.pending && !outcome.resumed)
            send({ type: "resumeFailed", pending: outcome.pending });
        },
        onError: (error) => {
          approve.reset();
          send({ type: "failed", error: paymentErrorKey(error) });
        },
      },
    );
  };
  const decline = () => {
    if (!payment) return;
    send({ type: "reject" });
    reject.mutate(payment.id, {
      onSuccess: (outcome) => {
        reject.reset();
        settle();
        if (outcome.pending && !outcome.resumed) {
          send({ type: "rejected" });
          send({ type: "resumeFailed", pending: outcome.pending });
          return;
        }
        declined();
      },
      onError: (error) => {
        reject.reset();
        send({ type: "failed", error: paymentErrorKey(error) });
      },
    });
  };
  const retryResume = () => {
    const pending = state.resumeFailed;
    if (!pending) return;
    resume.mutate(pending, {
      onSuccess: () => {
        send({ type: "resumed" });
        if (state.phase === "rejected") declined();
      },
    });
  };
  const busy = state.phase === "approving" || state.phase === "rejecting" || resume.isPending;
  const done = state.phase === "submitted" || state.phase === "rejected";
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) close();
      }}
      title={t("vault.payment.title")}
      description={done || missing ? undefined : t("vault.payment.description")}
      {...(done || missing || !payment
        ? { cancelLabel: t("common.close") }
        : {
            submit: {
              label: t("vault.payment.approve"),
              pending: state.phase === "approving",
              disabled: expired || busy,
              testId: "vault-payment-approve",
            },
            onSubmit: submit,
            actions: (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={decline}
                data-testid="vault-payment-reject"
              >
                {t("vault.payment.reject")}
              </Button>
            ),
          })}
      error={state.error ? dialogFailure(t(state.error), null) : null}
      testId="vault-payment"
    >
      {missing ? (
        <p className="text-sm" data-testid="vault-payment-missing">
          {t("vault.payment.notFound")}
        </p>
      ) : done ? (
        <div className="grid gap-3">
          <p className="text-sm" role="status" data-testid="vault-payment-submitted">
            {t(state.phase === "rejected" ? "vault.payment.rejected" : "vault.payment.submitted")}
          </p>
          <ResumeNotice
            pending={state.resumeFailed}
            retrying={resume.isPending}
            onRetry={retryResume}
          />
        </div>
      ) : payment ? (
        <div className="grid gap-4">
          <PaymentFacts payment={payment} now={now} />
          {expired ? null : (
            <CvvInput
              value={state.cvv}
              brand={payment.brand}
              error={state.touched && problem ? t(problem) : null}
              disabled={busy}
              onChange={(cvv) => send({ type: "type", cvv })}
            />
          )}
        </div>
      ) : null}
    </FormDialog>
  );
}

function useOpenPayment(openId: string | null, enabled = true) {
  const payments = usePendingPayments(enabled);
  const [held, setHeld] = useState<Payment | null>(null);
  const items = useMemo(
    () => (payments.data ?? []).map(paymentView).filter((p) => p.status === "pending"),
    [payments.data],
  );
  const live = items.find((payment) => payment.id === openId) ?? null;
  useEffect(() => {
    if (live) setHeld(live);
  }, [live]);
  const open = live ?? (held && held.id === openId ? held : null);
  const missing = openId !== null && !open && payments.isSuccess;
  return { payments, items, open, missing, forget: () => setHeld(null) };
}

export function clearPaymentLink(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("payment")) return;
  url.searchParams.delete("payment");
  window.history.replaceState(window.history.state, "", url);
}

export function LinkedPaymentApproval() {
  const [openId, setOpenId] = useState<string | null>(() =>
    typeof window === "undefined" ? null : paymentFromUrl(window.location.search),
  );
  const { open, missing, forget } = useOpenPayment(openId, openId !== null);
  if (openId === null) return null;
  return (
    <PaymentApprovalDialog
      payment={open}
      missing={missing}
      onClose={() => {
        setOpenId(null);
        forget();
        clearPaymentLink();
      }}
    />
  );
}

export function PaymentApprovalFor({ id, onClose }: { id: string; onClose(): void }) {
  const { open, missing, forget } = useOpenPayment(id);
  return (
    <PaymentApprovalDialog
      payment={open}
      missing={missing}
      onClose={() => {
        forget();
        onClose();
      }}
    />
  );
}

export function PaymentsSection({
  linkedId,
  onLinkHandled,
}: {
  linkedId: string | null;
  onLinkHandled(): void;
}) {
  const { t, locale } = useI18n();
  const [openId, setOpenId] = useState<string | null>(linkedId);
  const { payments, items, open, missing, forget } = useOpenPayment(openId);
  if (!payments.isPending && !payments.isError && items.length === 0 && !openId) return null;
  return (
    <section
      className="grid gap-2"
      aria-labelledby="vault-payments-title"
      data-testid="vault-payments"
    >
      <SectionHeading id="vault-payments-title" className="text-sm font-semibold">
        {t("vault.payments.title")}
      </SectionHeading>
      <p className="text-sm text-muted-foreground">{t("vault.payments.intro")}</p>
      {payments.isPending ? (
        <DataState state="loading" testId="vault-payments-loading" />
      ) : payments.isError ? (
        <DataState
          state="error"
          line={t("vault.payments.loadFailed")}
          error={payments.error}
          onRetry={() => void payments.refetch()}
          testId="vault-payments-failed"
        />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="vault-payments-empty">
          {t("vault.payments.empty")}
        </p>
      ) : (
        <Panel className="px-4 py-1">
          <ul className="divide-y">
            {items.map((payment) => (
              <li
                key={payment.id}
                className="flex flex-wrap items-center gap-3 py-3"
                data-testid={`vault-payment-${payment.id}`}
              >
                <CreditCard aria-hidden="true" className="size-4 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block font-mono text-sm">{payment.host}</span>
                  <span className="block text-xs text-muted-foreground">
                    {[
                      formatMinor(locale, payment.amountMinor, payment.currency),
                      cardLabel(payment),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <Button
                  size="sm"
                  onClick={() => setOpenId(payment.id)}
                  data-testid={`vault-payment-${payment.id}-open`}
                >
                  {t("vault.payment.open")}
                </Button>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      <PaymentApprovalDialog
        payment={open}
        missing={missing}
        onClose={() => {
          setOpenId(null);
          forget();
          onLinkHandled();
        }}
      />
    </section>
  );
}
