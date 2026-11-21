import type { DropChoice, DropVia } from "../shared/drop-model.ts";
import { modifierLabel, shortcutLabel } from "../shared/quick-capture-model.ts";
import { fill, type ShellMessages } from "../shared/shell-i18n.ts";
import { quickCaptureAccelerator } from "../shared/tray-model.ts";

export interface ShellDict {
  common: { close: string; cancel: string };
  md: {
    quick: {
      title: string;
      hint: string;
      ph: string;
      send: string;
      label: string;
      keys: string;
      offline: string;
      failed: string;
    };
    drop: {
      title: string;
      lead: (n: number) => string;
      via: Record<DropVia, string>;
      choices: Record<DropChoice, [string, string]>;
      reasons: {
        tooLarge: (max: string) => string;
        tooMany: (max: number) => string;
        unsupported: string;
        offline: string;
      };
      failed: string;
    };
  };
  browser: {
    label: string;
    reauthTitle: (name: string) => string;
    reauthBody: string;
    reauthConfirm: string;
    cancel: string;
    succeeded: string;
    failed: string;
  };
}

export function shellDict(m: ShellMessages, platform: string): ShellDict {
  const keys = { ctrl: m["key.ctrl"], space: m["key.space"] };
  return {
    common: { close: m["common.close"], cancel: m["common.cancel"] },
    md: {
      quick: {
        title: m["quick.title"],
        hint: fill(m["quick.hint"], {
          key: shortcutLabel(quickCaptureAccelerator(platform), platform, keys),
        }),
        ph: m["quick.ph"],
        send: m["quick.send"],
        label: m["quick.label"],
        keys: fill(m["quick.keys"], { mod: modifierLabel(platform, keys) }),
        offline: m["common.offline"],
        failed: m["quick.failed"],
      },
      drop: {
        title: m["drop.title"],
        lead: (n) => (n === 1 ? m["drop.lead.one"] : fill(m["drop.lead.many"], { count: n })),
        via: { window: m["drop.via.window"], dock: m["drop.via.dock"], tray: m["drop.via.tray"] },
        choices: {
          file: [m["drop.choice.file"], m["drop.choice.file.hint"]],
          source: [m["drop.choice.source"], m["drop.choice.source.hint"]],
          chat: [m["drop.choice.chat"], m["drop.choice.chat.hint"]],
          inbox: [m["drop.choice.inbox"], m["drop.choice.inbox.hint"]],
        },
        reasons: {
          tooLarge: (max) => fill(m["drop.reason.tooLarge"], { max }),
          tooMany: (max) => fill(m["drop.reason.tooMany"], { max }),
          unsupported: m["drop.reason.unsupported"],
          offline: m["drop.reason.offline"],
        },
        failed: m["drop.failed"],
      },
    },
    browser: {
      label: m["browser.label"],
      reauthTitle: (name) => fill(m["browser.reauthTitle"], { name }),
      reauthBody: m["browser.reauthBody"],
      reauthConfirm: m["browser.reauthConfirm"],
      cancel: m["browser.cancel"],
      succeeded: m["browser.succeeded"],
      failed: m["browser.failed"],
    },
  };
}
