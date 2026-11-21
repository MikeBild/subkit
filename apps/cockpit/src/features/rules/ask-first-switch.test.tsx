import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SETUP_KEY } from "@/api/setup";
import { render } from "@/components/cockpit/patterns/test-utils";
import { AskFirstSwitch } from "./ask-first-switch";

function shown(askBeforeWriting: boolean | null, locale: "de" | "en" = "de"): string {
  const client = new QueryClient();
  if (askBeforeWriting !== null)
    client.setQueryData(SETUP_KEY, { ask_before_writing: askBeforeWriting });
  return render(
    <QueryClientProvider client={client}>
      <AskFirstSwitch />
    </QueryClientProvider>,
    locale,
  );
}

describe("always ask first", () => {
  test("the switch names the rule and what still runs without a question", () => {
    const html = shown(false);
    expect(html).toContain("Immer vorher fragen");
    expect(html).toContain("Lesen läuft weiter ohne Frage.");
    expect(shown(false, "en")).toContain("Always ask first");
  });

  test("the switch reads the stored choice", () => {
    expect(shown(true)).toContain('aria-checked="true"');
    expect(shown(false)).toContain('aria-checked="false"');
  });

  test("the switch stays locked until the choice has loaded", () => {
    expect(shown(null)).toMatch(
      /data-testid="settings-rules-ask-first-switch"[^>]*disabled|disabled=""[^>]*data-testid="settings-rules-ask-first-switch"/,
    );
  });
});
