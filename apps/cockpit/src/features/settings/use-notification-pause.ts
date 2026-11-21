import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useUi } from "@ui/lib/ui-context";
import {
  NOTIFICATION_PAUSE_KEY,
  type NotificationPause,
  pauseNotifications,
  resumeNotifications,
  useNotificationPause,
} from "@/api/notification-pause";
import { useSetup } from "@/api/setup";
import { useSession } from "@/app/session";
import { LOCALE_TAGS } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { browserTimeZone } from "@/lib/timezones";
import { type PauseOption, pauseLabel, pauseRequest } from "./pause-model";

export function usePauseControl() {
  const { t, locale } = useI18n();
  const { now } = useUi();
  const session = useSession();
  const setup = useSetup();
  const client = useQueryClient();
  const query = useNotificationPause();
  const zone = setup.data?.timezone ?? session.tenant.timezone ?? browserTimeZone();
  const store = (stored: NotificationPause) => client.setQueryData(NOTIFICATION_PAUSE_KEY, stored);
  const pause = useMutation({
    mutationFn: (option: PauseOption) => pauseNotifications(pauseRequest(option, now(), zone)),
    onSuccess: store,
  });
  const resume = useMutation({ mutationFn: resumeNotifications, onSuccess: store });
  const failed = pause.isError ? pause.error : resume.isError ? resume.error : null;
  return {
    loaded: query.data !== undefined,
    label: pauseLabel(query.data, now(), zone, LOCALE_TAGS[locale], t),
    busy: pause.isPending || resume.isPending,
    error: failed,
    pause: (option: PauseOption) => {
      resume.reset();
      pause.mutate(option);
    },
    resume: () => {
      pause.reset();
      resume.mutate();
    },
    retry: () => {
      if (pause.isError && pause.variables) pause.mutate(pause.variables);
      else if (resume.isError) resume.mutate();
    },
  };
}

export type PauseControl = ReturnType<typeof usePauseControl>;
