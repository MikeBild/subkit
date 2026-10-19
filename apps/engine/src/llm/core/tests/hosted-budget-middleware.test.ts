import { describe, expect, test } from "bun:test";
import { APICallError, generateText, wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { setConfigKey } from "../../../config/loader.ts";
import { ConfigSchema } from "../../../config/schema.ts";
import { hostedBudgetReservations } from "../../../db/schema/index.ts";
import { createTestDb } from "../../../db/tests/setup.ts";
import { provisionSelfServiceTenant } from "../../../identity/self-service.ts";
import { createDeterministicUuidFactory } from "../../../test-helpers/determinism/ids.ts";
import { configureHostedPolicyForTests } from "../../../test-helpers/hosted-policy.ts";
import { hostedReportedAmount, hostedReservationAmount } from "../hosted-billing-policy.ts";
import {
  type HostedBillingDependencies,
  hostedBudgetMiddleware,
  wrapHostedBudgetModel,
} from "../hosted-budget-middleware.ts";

type CallOptions = Parameters<MockLanguageModelV4["doGenerate"]>[0];
type GenerateResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;
type Usage = GenerateResult["usage"];
type StreamPart =
  Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"] extends ReadableStream<infer Part>
    ? Part
    : never;

const nextId = createDeterministicUuidFactory(3811);
const tenantId = nextId();
const otherTenantId = nextId();
const policy = {
  model: "anthropic:billing-model",
  max_context_tokens: 1000,
  max_output_tokens: 100,
  input_usd_per_million_tokens: "3.125",
  output_usd_per_million_tokens: "15.5",
  cache_read_usd_per_million_tokens: "0.3125",
  cache_write_5m_usd_per_million_tokens: "3.90625",
  cache_write_1h_usd_per_million_tokens: "6.25",
};
const usage: Usage = {
  inputTokens: { total: 13, noCache: 10, cacheRead: 2, cacheWrite: 1 },
  outputTokens: { total: 4, text: 4, reasoning: 0 },
};
const result: GenerateResult = {
  content: [{ type: "text", text: "Hello" }],
  finishReason: { unified: "stop", raw: undefined },
  usage,
  warnings: [],
};
const params = (): CallOptions => ({
  prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
});

function fixture() {
  const config = ConfigSchema.parse({
    database: { url: "postgres://fixture.invalid/fixture" },
    llm: {
      hosted: {
        enabled: true,
        tenant_monthly_microunits: "1000000",
        global_monthly_microunits: "2000000",
        models: [policy],
      },
    },
  });
  const reserved: Parameters<HostedBillingDependencies["reserve"]>[0][] = [];
  const settled: { tenant: string; id: string; amount: bigint }[] = [];
  let context: string | undefined = tenantId;
  let origin = "self_service";
  let created = true;
  const deps: HostedBillingDependencies = {
    config: () => config,
    contextTenant: () => context,
    tenant: async () => ({ origin }),
    requestKey: () => `attempt-${reserved.length}`,
    reserve: async (input) => {
      reserved.push(input);
      return { created, reservation: { id: `reservation-${reserved.length}` } };
    },
    settle: async (tenant, id, amount) => {
      settled.push({ tenant, id, amount });
    },
  };
  function wrap(mock = new MockLanguageModelV4({ doGenerate: result })) {
    return {
      mock,
      model: wrapLanguageModel({
        model: mock,
        middleware: hostedBudgetMiddleware("anthropic", "billing-model", tenantId, deps),
      }),
    };
  }
  return {
    config,
    reserved,
    settled,
    deps,
    wrap,
    setContext: (value: string | undefined) => {
      context = value;
    },
    setOrigin: (value: string) => {
      origin = value;
    },
    setCreated: (value: boolean) => {
      created = value;
    },
  };
}

describe("hosted provider budget boundary", () => {
  test("reserves worst-case context and caps provider output before dispatch", async () => {
    const f = fixture();
    const { mock, model } = f.wrap();
    await model.doGenerate({ ...params(), maxOutputTokens: 10000 });
    expect(f.reserved[0]?.reserved_microunits).toBe(7800n);
    expect(mock.doGenerateCalls[0]?.maxOutputTokens).toBe(100);
    expect(f.settled[0]?.amount).toBe(98n);
  });

  test("uses exact decimal cache rates and rounds the final microunit upward", () => {
    expect(hostedReservationAmount(policy)).toBe(7800n);
    expect(hostedReportedAmount(policy, usage, "1h")).toBe(101n);
    expect(
      hostedReportedAmount(
        policy,
        { ...usage, inputTokens: { ...usage.inputTokens, cacheWrite: undefined } },
        "1h",
      ),
    ).toBeUndefined();
  });

  test("large prices preserve every microunit beyond floating point integer precision", () => {
    expect(
      hostedReportedAmount(
        { ...policy, input_usd_per_million_tokens: "10000000000.000001" },
        {
          inputTokens: { total: 1000000, noCache: 1000000, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        "5m",
      ),
    ).toBe(10000000000000001n);
  });

  test("function tools and known prompt cache options retain budget coverage", async () => {
    const f = fixture();
    const { model } = f.wrap();
    await model.doGenerate({
      ...params(),
      providerOptions: { anthropic: { disableParallelToolUse: true } },
      prompt: [
        {
          role: "system",
          content: "stable",
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } },
        },
      ],
      tools: [
        { type: "function", name: "lookup", inputSchema: { type: "object", properties: {} } },
      ],
    });
    expect(f.settled[0]?.amount).toBe(101n);
  });

  test("native paid tools fail before reservation or provider dispatch", async () => {
    const f = fixture();
    const { mock, model } = f.wrap();
    await expect(
      model.doGenerate({
        ...params(),
        tools: [{ type: "provider", id: "anthropic.web_search", name: "search", args: {} }],
      }),
    ).rejects.toThrow("provider-native paid tools");
    expect(f.reserved).toHaveLength(0);
    expect(mock.doGenerateCalls).toHaveLength(0);
  });

  test("unpriced provider options and multimodal input fail before dispatch", async () => {
    const f = fixture();
    const { mock, model } = f.wrap();
    await expect(
      model.doGenerate({
        ...params(),
        providerOptions: { anthropic: { serviceTier: "priority" } },
      }),
    ).rejects.toThrow("no verified cost envelope");
    await expect(
      model.doGenerate({
        prompt: [
          {
            role: "user",
            content: [
              {
                type: "file",
                mediaType: "image/png",
                data: { type: "data", data: new Uint8Array([1]) },
              },
            ],
          },
        ],
      }),
    ).rejects.toThrow("multimodal");
    expect(mock.doGenerateCalls).toHaveLength(0);
  });

  test("disabled signup cannot disable budgets for an existing hosted tenant", async () => {
    const f = fixture();
    f.config.auth.hosted.enabled = false;
    f.config.llm.hosted.enabled = false;
    f.config.llm.hosted.tenant_monthly_microunits = "0";
    const { mock, model } = f.wrap();
    await expect(model.doGenerate(params())).rejects.toThrow("money budgets are missing");
    expect(mock.doGenerateCalls).toHaveLength(0);
  });

  test("missing or conflicting authenticated tenant context cannot use a platform key", async () => {
    const f = fixture();
    f.setContext(undefined);
    const model = wrapLanguageModel({
      model: new MockLanguageModelV4({ doGenerate: result }),
      middleware: hostedBudgetMiddleware("anthropic", "billing-model", undefined, f.deps),
    });
    await expect(model.doGenerate(params())).rejects.toThrow("tenant context is required");
    f.setContext(otherTenantId);
    await expect(f.wrap().model.doGenerate(params())).rejects.toThrow("do not match");
    expect(f.reserved).toHaveLength(0);
  });

  test("idempotent reservations never dispatch a second provider attempt", async () => {
    const f = fixture();
    f.setCreated(false);
    const { mock, model } = f.wrap();
    await expect(model.doGenerate(params())).rejects.toThrow("already reserved");
    expect(mock.doGenerateCalls).toHaveLength(0);
    expect(f.settled).toHaveLength(0);
  });

  test("missing or ambiguous model policy fails before dispatch", async () => {
    const f = fixture();
    const { mock, model } = f.wrap();
    f.config.llm.hosted.models = [];
    await expect(model.doGenerate(params())).rejects.toThrow("no unique verified billing policy");
    f.config.llm.hosted.models = [policy, policy];
    await expect(model.doGenerate(params())).rejects.toThrow("no unique verified billing policy");
    expect(mock.doGenerateCalls).toHaveLength(0);
  });

  test("self-hosted tenants preserve existing model behavior", async () => {
    const f = fixture();
    f.setOrigin("operator");
    const { mock, model } = f.wrap();
    await model.doGenerate({ ...params(), maxOutputTokens: 10000 });
    expect(mock.doGenerateCalls[0]?.maxOutputTokens).toBe(10000);
    expect(f.reserved).toHaveLength(0);
  });

  test("provider failures and unknown usage retain their reservation", async () => {
    const f = fixture();
    const failure = f.wrap(
      new MockLanguageModelV4({
        doGenerate: async () => {
          throw new Error("provider failed");
        },
      }),
    );
    await expect(failure.model.doGenerate(params())).rejects.toThrow("provider failed");
    await f
      .wrap(
        new MockLanguageModelV4({
          doGenerate: {
            ...result,
            usage: {
              ...usage,
              outputTokens: { total: undefined, text: undefined, reasoning: undefined },
            },
          },
        }),
      )
      .model.doGenerate(params());
    expect(f.reserved).toHaveLength(2);
    expect(f.settled).toHaveLength(0);
  });

  test("stream finish settles once; stream cancellation retains reserved money", async () => {
    const f = fixture();
    const parts: StreamPart[] = [
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", delta: "Hello" },
      { type: "text-end", id: "text" },
      { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
    ];
    const stream = () =>
      new ReadableStream<StreamPart>({
        start(controller) {
          for (const part of parts) controller.enqueue(part);
          controller.close();
        },
      });
    const model = f.wrap(
      new MockLanguageModelV4({ doStream: async () => ({ stream: stream() }) }),
    ).model;
    const finished = await model.doStream(params());
    await finished.stream.pipeTo(new WritableStream({ write() {} }));
    expect(f.settled).toHaveLength(1);
    const pending = await model.doStream(params());
    await pending.stream.cancel();
    expect(f.reserved).toHaveLength(2);
    expect(f.settled).toHaveLength(1);
  });

  test("a stream error retains its reservation even if a later finish reports usage", async () => {
    const f = fixture();
    const { model } = f.wrap(
      new MockLanguageModelV4({
        doStream: async () => ({
          stream: new ReadableStream<StreamPart>({
            start(controller) {
              controller.enqueue({ type: "error", error: new Error("stream interrupted") });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                usage,
              });
              controller.close();
            },
          }),
        }),
      }),
    );
    const response = await model.doStream(params());
    await response.stream.pipeTo(new WritableStream({ write() {} }));
    expect(f.reserved).toHaveLength(1);
    expect(f.settled).toHaveLength(0);
  });

  test("SDK retry attempts get separate reservations and only known usage settles", async () => {
    const f = fixture();
    let calls = 0;
    const model = f.wrap(
      new MockLanguageModelV4({
        doGenerate: async () => {
          calls += 1;
          if (calls === 1)
            throw new APICallError({
              message: "retry",
              url: "https://provider.invalid",
              requestBodyValues: {},
              statusCode: 429,
              isRetryable: true,
            });
          return result;
        },
      }),
    ).model;
    await generateText({ model, prompt: "Hello", maxRetries: 1 });
    expect(calls).toBe(2);
    expect(f.reserved.map((entry) => entry.request_key)).toEqual(["attempt-0", "attempt-1"]);
    expect(f.settled).toHaveLength(1);
  });
});

test("an explicit database owns hosted model reservation and settlement", async () => {
  const database = await createTestDb("model-billing-context");
  try {
    await configureHostedPolicyForTests(database.db, "postgres://fixture.invalid/unavailable");
    await setConfigKey("llm.hosted.models", [policy]);
    await setConfigKey("llm.hosted.tenant_monthly_microunits", "1000000");
    await setConfigKey("llm.hosted.global_monthly_microunits", "2000000");
    const created = await provisionSelfServiceTenant(
      {
        issuer_url: "https://identity.example.test",
        subject: "model-billing",
        email: "billing@example.test",
        email_verified: true,
      },
      database.db,
    );
    const mock = new MockLanguageModelV4({ doGenerate: result });
    const model = await wrapHostedBudgetModel(
      mock,
      "anthropic",
      "billing-model",
      created.tenant.id,
      database.db,
    );
    if (typeof model === "string") throw new Error("expected a wrapped model");
    await model.doGenerate({ ...params(), maxOutputTokens: 100 });
    const reservations = await database.db.select().from(hostedBudgetReservations);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]?.tenant_id).toBe(created.tenant.id);
    expect(reservations[0]?.state).toBe("settled");
    expect(reservations[0]?.reported_microunits).toBe(hostedReportedAmount(policy, usage, "5m"));
    const unlisted = await wrapHostedBudgetModel(
      mock,
      "anthropic",
      "unlisted",
      created.tenant.id,
      database.db,
    );
    if (typeof unlisted === "string") throw new Error("expected a wrapped model");
    await expect(unlisted.doGenerate({ ...params(), maxOutputTokens: 100 })).rejects.toThrow();
    expect(mock.doGenerateCalls).toHaveLength(1);
    expect(await database.db.select().from(hostedBudgetReservations)).toHaveLength(1);
  } finally {
    await database.cleanup();
  }
});
