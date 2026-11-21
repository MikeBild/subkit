import { expect, test } from "bun:test";
import {
  LOCAL_SETTINGS_PROTOCOL,
  localSettingsOpenerOf,
} from "@/features/settings/model/desktop-local-settings";

test("the desktop's local settings open only when its bridge offers them", () => {
  let opened = 0;
  const open = localSettingsOpenerOf({
    protocolVersion: LOCAL_SETTINGS_PROTOCOL,
    openLocalCapabilities: () => opened++,
  });
  open?.();
  expect(opened).toBe(1);
  expect(localSettingsOpenerOf({ protocolVersion: LOCAL_SETTINGS_PROTOCOL })).toBeNull();
  expect(localSettingsOpenerOf(undefined)).toBeNull();
});

test("a bridge older than protocol 7 never opens local settings", () => {
  expect(LOCAL_SETTINGS_PROTOCOL).toBe(7);
  expect(localSettingsOpenerOf({ protocolVersion: 6, openLocalCapabilities: () => {} })).toBeNull();
  expect(localSettingsOpenerOf({ openLocalCapabilities: () => {} })).toBeNull();
});
