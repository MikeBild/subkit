import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { sendInvite } from "@/api/invite-send";
import { useI18n } from "@/lib/i18n-context";
import { refusalToast } from "./data";
import { type IssuedInvite, sendOutcome, sendWaitMinutes } from "./model/invite-send-model";

export function useInviteSend() {
  const { t } = useI18n();
  const [link, setLink] = useState<IssuedInvite | null>(null);
  const send = useMutation({
    mutationFn: (target: { id: string; email: string }) => sendInvite(target.id),
    onSuccess: (delivery, target) => {
      const outcome = sendOutcome(delivery, target.email);
      if (outcome.kind === "link") setLink(outcome.invite);
      else toast.success(t("people.invite.sent", { to: outcome.to }));
    },
    onError: (error) => {
      const minutes = sendWaitMinutes(error);
      if (minutes === null) refusalToast(error, t);
      else toast.error(t("people.invite.wait", { minutes }));
    },
  });
  return {
    send: (id: string, email: string) => send.mutate({ id, email }),
    pending: send.isPending,
    link,
    closeLink: () => setLink(null),
  };
}
