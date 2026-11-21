import { describe, expect, it } from "bun:test";
import { BusyButton } from "@ui/components/proto/BusyButton";
import { SettingRow } from "@ui/components/proto/SettingRow";
import { StepDots } from "@ui/components/proto/StepDots";
import { StepFooter } from "@ui/components/proto/StepFooter";
import { VersionChips } from "@ui/components/proto/VersionChips";
import { OnboardingFrame } from "@ui/components/templates/OnboardingFrame";
import { UiProvider } from "@ui/lib/ui-context";
import { Bell } from "lucide-react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const html = (node: ReactNode) =>
  renderToStaticMarkup(
    <UiProvider lang="en" now={() => 0}>
      {node}
    </UiProvider>,
  );

const count = (markup: string, text: string) => markup.split(text).length - 1;

describe("BusyButton", () => {
  it("keeps both labels in one grid cell so the width never changes", () => {
    const idle = html(
      <BusyButton busy={false} busyLabel="Checking" data-testid="check">
        Check
      </BusyButton>,
    );
    expect(count(idle, "col-start-1 row-start-1")).toBe(2);
    expect(idle).toContain('data-testid="check"');
    expect(idle).toContain('aria-busy="false"');
    expect(idle).not.toContain('disabled=""');
  });

  it("is disabled and busy while working, and hides the idle label", () => {
    const busy = html(
      <BusyButton busy busyLabel="Checking">
        Check
      </BusyButton>,
    );
    expect(busy).toContain('aria-busy="true"');
    expect(busy).toContain('disabled=""');
    expect(busy).toContain("animate-spin");
    expect(busy).toMatch(/invisible[^"]*">Check</);
  });
});

describe("VersionChips", () => {
  it("renders nothing without chips", () => {
    expect(html(<VersionChips chips={[]} />)).toBe("");
  });

  it("renders one mono pill per chip in its tone", () => {
    const markup = html(
      <VersionChips
        chips={[
          { text: "Server 10.4.0", tone: "warning" },
          { text: "Needs 11.2.0+", tone: "neutral" },
        ]}
      />,
    );
    expect(count(markup, "font-mono")).toBe(2);
    expect(markup).toContain("text-warning-ink");
    expect(markup).toContain("Needs 11.2.0+");
  });
});

describe("SettingRow", () => {
  it("ties the label to its control and shows the hint", () => {
    const markup = html(
      <SettingRow id="quiet" label="Quiet hours" hint="No alerts at night" icon={Bell}>
        <input id="quiet" />
      </SettingRow>,
    );
    expect(markup).toContain('for="quiet"');
    expect(markup).toContain("No alerts at night");
    expect(markup).toContain("<svg");
  });

  it("leaves out hint and icon when none are given", () => {
    const markup = html(
      <SettingRow label="Language">
        <span>EN</span>
      </SettingRow>,
    );
    expect(markup).not.toContain("<p");
    expect(markup).not.toContain("<svg");
  });
});

describe("StepDots", () => {
  it("draws the current step as a bar and the others as dots", () => {
    const markup = html(<StepDots current={1} total={3} label="Step 2 of 3" />);
    expect(count(markup, "w-6 bg-accent")).toBe(1);
    expect(count(markup, "w-2 bg-accent")).toBe(1);
    expect(count(markup, "w-2 bg-muted-foreground/30")).toBe(1);
    expect(count(markup, 'aria-current="step"')).toBe(1);
    expect(markup).toContain('aria-label="Step 2 of 3"');
  });

  it("keeps its space when hidden", () => {
    const markup = html(<StepDots visible={false} current={0} total={2} label="Step 1 of 2" />);
    expect(markup).toContain("invisible");
    expect(markup).toContain('aria-hidden="true"');
  });
});

describe("StepFooter", () => {
  it("keeps the space of a missing back button and takes it out of the tab order", () => {
    const markup = html(<StepFooter disabled next={() => {}} backLabel="Back" nextLabel="Next" />);
    expect(markup).toMatch(/invisible[^"]*"[^>]*tabindex="-1"/);
    expect(markup).toContain('data-testid="step-next"');
    expect(markup).toContain('disabled=""');
  });

  it("shows only the way back when asked", () => {
    const markup = html(<StepFooter backOnly back={() => {}} backLabel="Back" nextLabel="Next" />);
    expect(markup).toContain("Back");
    expect(markup).not.toContain("Next");
  });

  it("prefers its own label and offers a skip next to it", () => {
    const markup = html(
      <StepFooter
        next={() => {}}
        label="Allow"
        skip={() => {}}
        skipLabel="Later"
        backLabel="Back"
        nextLabel="Next"
        testId="perm"
      />,
    );
    expect(markup).toContain("Allow");
    expect(markup).not.toContain(">Next<");
    expect(markup).toContain('data-testid="perm-skip"');
    expect(markup).toContain('data-testid="perm-back"');
  });
});

describe("OnboardingFrame", () => {
  it("places brand, actions, dots, content and foot in one frame", () => {
    const markup = html(
      <OnboardingFrame
        brand="SubKit"
        actions={<span>act</span>}
        dots={<StepDots current={0} total={2} label="Step 1 of 2" />}
        foot="Version 1.0.0"
      >
        <p>body</p>
      </OnboardingFrame>,
    );
    expect(markup).toContain("onboarding-frame");
    expect(markup).toContain("onboarding-column");
    expect(markup).toContain("SubKit");
    expect(markup).toContain("<span>act</span>");
    expect(markup).toContain('aria-label="Step 1 of 2"');
    expect(markup).toContain("Version 1.0.0");
  });

  it("renders a step footer inline until its slot exists", () => {
    const markup = html(
      <OnboardingFrame brand="SubKit">
        <StepFooter next={() => {}} backLabel="Back" nextLabel="Next" />
      </OnboardingFrame>,
    );
    expect(markup).toContain('data-testid="step-next"');
    expect(markup).not.toContain("text-center text-xs");
  });
});
