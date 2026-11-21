import { Pill, type Tone } from "@ui/components/proto/Pill";

export function VersionChips({ chips }: { chips: { text: string; tone: Tone }[] }) {
  if (chips.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {chips.map((chip) => (
        <Pill key={chip.text} tone={chip.tone} className="font-mono">
          {chip.text}
        </Pill>
      ))}
    </span>
  );
}
