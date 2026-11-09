import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@/components/cockpit/patterns/test-utils";
import { WorkflowInputOutput } from "@/components/cockpit/workflow-io";

function view(definition: Record<string, unknown>, byWebhook = false): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    return render(
      <QueryClientProvider client={client}>
        <WorkflowInputOutput
          workflowId="workflow-1"
          byWebhook={byWebhook}
          draftDefinition={definition}
        />
      </QueryClientProvider>,
    );
  } finally {
    client.clear();
  }
}

test("renders the draft's required input and declared output instead of waiting for invocation data", () => {
  const markup = view(
    {
      input_schema: {
        type: "object",
        required: ["recipient"],
        properties: {
          recipient: { type: "string", format: "email", description: "Recipient address" },
        },
      },
      output_schema: {
        type: "object",
        properties: { accepted: { type: "boolean" } },
      },
    },
    true,
  );

  expect(markup).toContain('data-testid="workflow-io"');
  expect(markup).toContain('data-testid="workflow-input-table-row-0"');
  expect(markup).toContain("recipient");
  expect(markup).toContain("E-Mail · Pflicht");
  expect(markup).toContain('data-testid="workflow-output-table-row-0"');
  expect(markup).toContain("accepted");
  expect(markup).toContain('data-testid="workflow-input-webhook"');
  expect(markup).not.toContain('data-testid="workflow-io-failed"');
});

test("makes an intentionally empty draft input visible while still showing output facts", () => {
  const markup = view({
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    output_schema: { type: "object", properties: { run_id: { type: "string" } } },
  });

  expect(markup).toContain('data-testid="workflow-input-none"');
  expect(markup).toContain('data-testid="workflow-output-table-row-0"');
  expect(markup).toContain("run_id");
  expect(markup).not.toContain('data-testid="workflow-input-where"');
});
