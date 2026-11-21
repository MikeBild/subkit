import { describe, expect, it } from "bun:test";
import { type UiLang, UiProvider } from "@ui/lib/ui-context";
import { SettingsRow } from "@ui/molecules/settings-row";
import { ToolApprovalCard } from "@ui/organisms/tool-approval-card";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const html = (node: ReactNode, lang: UiLang = "de") =>
  renderToStaticMarkup(<UiProvider lang={lang}>{node}</UiProvider>);

describe("tool approval card", () => {
  it("shows what runs, why, and the two decisions while it is pending", () => {
    const out = html(
      <ToolApprovalCard
        rows={[
          ["Aktion", "Senden"],
          ["Ziel", "Lena"],
        ]}
        quote="Schick Lena die Wochenzahlen"
        onDecision={() => {}}
        testId="card"
      />,
    );
    expect(out).toContain("Möchte das ausführen");
    expect(out).toContain("<dt");
    expect(out).toContain("Lena");
    expect(out).toContain("Weil du gesagt hast: „Schick Lena die Wochenzahlen“");
    expect(out).toContain('data-testid="card-approve"');
    expect(out).toContain('data-testid="card-decline"');
    expect(out).toContain("Wartet auf deine Entscheidung");
    expect(out).toContain("Gilt genau für diese Aktion, einmal.");
  });

  it("shows the decision once it is made, without buttons", () => {
    const allowed = html(<ToolApprovalCard status="allowed" onDecision={() => {}} />, "en");
    expect(allowed).toContain("Allowed once");
    expect(allowed).not.toContain("<button");
    expect(html(<ToolApprovalCard status="denied" onDecision={() => {}} />)).toContain(
      "Abgelehnt – nichts ausgeführt",
    );
  });

  it("takes its own title, labels, body, actions and footnote", () => {
    const out = html(
      <ToolApprovalCard
        title="Sign in again"
        labels={{ approve: "Continue", decline: "Not now" }}
        showPending={false}
        footnote={null}
        onDecision={() => {}}
      >
        <p>Body</p>
      </ToolApprovalCard>,
    );
    expect(out).toContain("Sign in again");
    expect(out).toContain("Continue");
    expect(out).toContain("Not now");
    expect(out).toContain("<p>Body</p>");
    expect(out).not.toContain("Wartet auf deine Entscheidung");
    expect(out).not.toContain("Gilt genau");
    const replaced = html(
      <ToolApprovalCard actions={<span>Decided elsewhere</span>} onDecision={() => {}} />,
    );
    expect(replaced).toContain("Decided elsewhere");
    expect(replaced).not.toContain("<button");
  });

  it("disables both decisions while busy", () => {
    const out = html(<ToolApprovalCard busy onDecision={() => {}} testId="card" />);
    expect(out.match(/disabled=""/g)?.length).toBe(2);
  });
});

describe("settings row", () => {
  it("keeps the content's geometry while loading and hides it from assistive tech", () => {
    const out = html(
      <SettingsRow id="x" label="Ordner" phase="skeleton" testId="row">
        <span>Control</span>
      </SettingsRow>,
    );
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain('data-testid="row"');
    expect(out).toContain("Control");
    expect(out).toContain("invisible");
  });

  it("shows a ready row without placeholders", () => {
    const out = html(<SettingsRow label="Ordner" hint="Hinweis" />);
    expect(out).toContain('aria-busy="false"');
    expect(out).toContain("Hinweis");
    expect(out).not.toContain("invisible");
  });
});
