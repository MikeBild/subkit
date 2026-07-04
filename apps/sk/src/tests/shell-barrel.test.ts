import { describe, expect, test } from "bun:test";
import * as shell from "../shell/index.ts";

describe("shell barrel", () => {
  test("re-exports every new component + type alias", () => {
    expect(typeof shell.ToastQueue).toBe("function");
    expect(typeof shell.useToast).toBe("function");
    expect(typeof shell.ErrorPanel).toBe("function");
    expect(typeof shell.errorToPanel).toBe("function");
    expect(typeof shell.ResizeBoundary).toBe("function");
    expect(typeof shell.VirtualTranscript).toBe("function");
    expect(typeof shell.MessageGutter).toBe("function");
    expect(typeof shell.IntegrationPicker).toBe("function");
    expect(typeof shell.OAuthWaitView).toBe("function");
    expect(typeof shell.SecretField).toBe("function");
    expect(typeof shell.SchemaForm).toBe("function");
    expect(typeof shell.StepCarousel).toBe("function");
    expect(typeof shell.RunsTable).toBe("function");
    expect(typeof shell.DiffApprover).toBe("function");
    expect(typeof shell.SlashSuggest).toBe("function");
    expect(typeof shell.findSlashCommandPositions).toBe("function");
    expect(typeof shell.spanAtCursor).toBe("function");
    expect(typeof shell.hasCommand).toBe("function");
    expect(typeof shell.classifySlash).toBe("function");
    expect(typeof shell.loadBootstrap).toBe("function");
    expect(typeof shell.appendEvent).toBe("function");
    expect(typeof shell.runShellHook).toBe("function");
    expect(typeof shell.useStatusLine).toBe("function");
    expect(typeof shell.ThemeProvider).toBe("function");
    expect(typeof shell.useTheme).toBe("function");
    expect(typeof shell.useThemeControl).toBe("function");
    expect(typeof shell.shouldForceNoColor).toBe("function");
    expect(typeof shell.loadDraft).toBe("function");
    expect(typeof shell.saveDraft).toBe("function");
    expect(typeof shell.clearDraft).toBe("function");
  });

  test("paletteFor + PALETTES round-trip", () => {
    expect(shell.paletteFor("dark")).toBe(shell.PALETTES.dark);
    expect(shell.paletteFor("light")).toBe(shell.PALETTES.light);
    expect(shell.paletteFor(undefined)).toBe(shell.defaultTheme);
  });
});
