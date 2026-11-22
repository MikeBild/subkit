import { CodeBlock } from "@/components/cockpit/patterns/code-block";

export function RawText({ text, label }: { text: string; label: string }) {
  return <CodeBlock fit code={text} label={label} testId="knowledge-raw" />;
}
