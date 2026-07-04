import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  PALETTES,
  type ThemeName,
  ThemeProvider,
  type ThemeTokens,
  useTheme,
  useThemeControl,
} from "@chat-ui/index.ts";
import { Box, Text } from "ink";
import { useEffect } from "react";
import { flush, renderInk } from "./helpers/ink.tsx";

function ProbeTokens({ onTokens }: { onTokens: (t: ThemeTokens) => void }) {
  const tokens = useTheme();
  useEffect(() => {
    onTokens(tokens);
  }, [tokens, onTokens]);
  return <Text color={tokens.role.assistant}>assistant</Text>;
}

function ProbeControl({
  onReady,
}: {
  onReady: (api: { name: ThemeName; setTheme: (n: ThemeName) => void }) => void;
}) {
  const ctl = useThemeControl();
  useEffect(() => {
    onReady(ctl);
  }, [ctl, onReady]);
  return null;
}

describe("<ThemeProvider>", () => {
  let originalEnv: NodeJS.ProcessEnv;
  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.NO_COLOR;
    delete process.env.SK_PLAIN;
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  test("default name=dark exposes the dark palette", async () => {
    const ref: { current: ThemeTokens | null } = { current: null };
    const ui = renderInk(
      <ThemeProvider>
        <Box>
          <ProbeTokens
            onTokens={(t) => {
              ref.current = t;
            }}
          />
        </Box>
      </ThemeProvider>,
    );
    try {
      await flush();
      expect(ref.current).not.toBeNull();
      expect(ref.current).toEqual(PALETTES.dark);
    } finally {
      ui.unmount();
    }
  });

  test("name=light selects the light palette", async () => {
    const ref: { current: ThemeTokens | null } = { current: null };
    const ui = renderInk(
      <ThemeProvider name="light">
        <Box>
          <ProbeTokens
            onTokens={(t) => {
              ref.current = t;
            }}
          />
        </Box>
      </ThemeProvider>,
    );
    try {
      await flush();
      expect(ref.current).toEqual(PALETTES.light);
    } finally {
      ui.unmount();
    }
  });

  test("forceNoColor selects the noColor palette regardless of name", async () => {
    const ref: { current: ThemeTokens | null } = { current: null };
    const ui = renderInk(
      <ThemeProvider name="dark" forceNoColor={true}>
        <Box>
          <ProbeTokens
            onTokens={(t) => {
              ref.current = t;
            }}
          />
        </Box>
      </ThemeProvider>,
    );
    try {
      await flush();
      expect(ref.current).toEqual(PALETTES.noColor);
    } finally {
      ui.unmount();
    }
  });

  test("setTheme switches the active palette at runtime", async () => {
    const apiRef: {
      current: { name: ThemeName; setTheme: (n: ThemeName) => void } | null;
    } = { current: null };
    const tokensRef: { current: ThemeTokens | null } = { current: null };
    const captureTokens = (t: ThemeTokens) => {
      tokensRef.current = t;
    };
    const captureApi = (a: { name: ThemeName; setTheme: (n: ThemeName) => void }) => {
      apiRef.current = a;
    };
    const ui = renderInk(
      <ThemeProvider name="dark">
        <Box>
          <ProbeTokens onTokens={captureTokens} />
          <ProbeControl onReady={captureApi} />
        </Box>
      </ThemeProvider>,
    );
    try {
      await flush();
      expect(apiRef.current).not.toBeNull();
      expect(tokensRef.current).toEqual(PALETTES.dark);
      apiRef.current!.setTheme("highContrast");
      // setTheme triggers a state change; wait for the next frame.
      for (let i = 0; i < 20 && tokensRef.current !== PALETTES.highContrast; i++) {
        await flush();
      }
      expect(tokensRef.current).toEqual(PALETTES.highContrast);
    } finally {
      ui.unmount();
    }
  });

  test("explicit value override beats the name selector", async () => {
    const custom: ThemeTokens = { ...PALETTES.dark, role: { ...PALETTES.dark.role, user: "ZAP" } };
    const ref: { current: ThemeTokens | null } = { current: null };
    const ui = renderInk(
      <ThemeProvider value={custom} name="light">
        <Box>
          <ProbeTokens
            onTokens={(t) => {
              ref.current = t;
            }}
          />
        </Box>
      </ThemeProvider>,
    );
    try {
      await flush();
      expect(ref.current?.role.user).toBe("ZAP");
    } finally {
      ui.unmount();
    }
  });
});
