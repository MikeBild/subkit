import { describe, expect, test } from "bun:test";
import { EVENT_TYPES } from "../webhooks/events/catalog.ts";
import { loadBuiltinTemplates, type TemplateCapabilities } from "./templates.ts";

const templates = loadBuiltinTemplates();

const EXPECTED_INVENTORY = {
  "app-store-connect": {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  airtable: {
    version: 1,
    capabilities: {
      webhooks: true,
      webhook_events: ["record.created", "record.updated"],
      rate_limits: { requests_per_second: 5, burst_size: 5, recommended_backoff_ms: 1000 },
    },
  },
  anthropic: {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  "appsync-cognito": {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  "appsync-iam": {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  asana: {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  "aws-apigw-iam": {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  "aws-cloudwatch-alarms": {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  "aws-cloudwatch-logs": {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  "aws-cloudwatch-metrics": {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  "aws-cognito-user-pools": {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  "aws-dynamodb": {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  "aws-eventbridge": {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  "aws-lambda": {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  "aws-s3": {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  "aws-ses": {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  "aws-sqs": {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  "aws-sts": {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  browserless: {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  cloudflare: {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  confluence: {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  digitalocean: {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  dropbox: {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  firebase: {
    version: 2,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  github: {
    version: 1,
    capabilities: {
      webhooks: true,
      webhook_events: ["push", "pull_request", "issues", "release"],
      rate_limits: { requests_per_second: 17, burst_size: 5000, recommended_backoff_ms: 1000 },
    },
  },
  "github-graphql": {
    version: 1,
    capabilities: {
      webhooks: false,
      webhook_events: [],
      rate_limits: { requests_per_second: 17, burst_size: 5000, recommended_backoff_ms: 1000 },
    },
  },
  "google-analytics": {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  "google-calendar": {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  "google-chat": {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  "google-cloud-storage": {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  "google-docs": {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  "google-drive": {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  "google-gmail": {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  "google-search-console": {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  "google-sheets": {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  "google-workspace": {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  http: {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  hubspot: {
    version: 1,
    capabilities: {
      webhooks: true,
      webhook_events: ["contact.creation", "contact.propertyChange", "deal.creation"],
      rate_limits: { requests_per_second: 10, burst_size: 10, recommended_backoff_ms: 1000 },
    },
  },
  intercom: {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  "jina-reader": {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  jira: {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  linear: {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  linkedin: {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  mailchimp: {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  monday: {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  notion: {
    version: 1,
    capabilities: {
      webhooks: false,
      webhook_events: [],
      rate_limits: { requests_per_second: 3, burst_size: 3, recommended_backoff_ms: 1000 },
    },
  },
  "oauth2-generic": {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  openai: {
    version: 1,
    capabilities: {
      webhooks: false,
      webhook_events: [],
      rate_limits: { requests_per_second: 10, burst_size: 20, recommended_backoff_ms: 1000 },
    },
  },
  postgres: {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  salesforce: {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  sendgrid: {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  shopify: {
    version: 1,
    capabilities: {
      webhooks: true,
      webhook_events: ["orders/create", "products/update", "customers/create"],
      rate_limits: { requests_per_second: 2, burst_size: 40, recommended_backoff_ms: 500 },
    },
  },
  slack: {
    version: 1,
    capabilities: {
      webhooks: true,
      webhook_events: ["message", "app_mention", "reaction_added"],
      rate_limits: { requests_per_second: 1, burst_size: 50, recommended_backoff_ms: 1000 },
    },
  },
  square: {
    version: 1,
    capabilities: {
      webhooks: true,
      webhook_events: ["payment.updated", "order.created"],
      rate_limits: null,
    },
  },
  stripe: {
    version: 1,
    capabilities: {
      webhooks: true,
      webhook_events: [
        "charge.created",
        "customer.created",
        "customer.updated",
        "invoice.paid",
        "payment_intent.succeeded",
      ],
      rate_limits: { requests_per_second: 100, burst_size: 25, recommended_backoff_ms: 500 },
    },
  },
  "subkit-support": {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  supabase: {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  "supabase-graphql": {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  twilio: {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  vercel: {
    version: 1,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  },
  "web-scraper": {
    version: 1,
    capabilities: {
      webhooks: false,
      webhook_events: [],
      rate_limits: { requests_per_second: 2, burst_size: 4, recommended_backoff_ms: 500 },
    },
  },
  "xray-cloud": {
    version: 1,
    capabilities: {
      webhooks: false,
      webhook_events: [],
      rate_limits: { requests_per_second: 1, burst_size: 300, recommended_backoff_ms: 5000 },
    },
  },
};

describe("connector-template catalog — inventory identity pin", () => {
  test("slug -> { version, capabilities } matches the pinned inventory exactly", () => {
    const actual: Record<string, { version: number; capabilities: TemplateCapabilities }> =
      Object.fromEntries(
        [...templates]
          .sort((a, b) => a.slug.localeCompare(b.slug))
          .map(
            (t) =>
              [t.slug, { version: t.version as number, capabilities: t.capabilities }] as const,
          ),
      );
    expect(actual).toEqual(EXPECTED_INVENTORY);
  });
});

describe("connector-template catalog — webhook-catalog cross-consistency", () => {
  test("templates carry the webhook_events field and it never collides with subkit's internal EVENT_TYPES", () => {
    const withEvents = templates.filter((t) => t.capabilities.webhook_events.length > 0);
    expect(withEvents.length).toBeGreaterThan(0);
    for (const t of withEvents) {
      for (const event of t.capabilities.webhook_events) {
        expect(event.length).toBeGreaterThan(0);
        expect((EVENT_TYPES as readonly string[]).includes(event)).toBe(false);
      }
    }
  });

  test("capabilities.webhooks is true iff webhook_events is non-empty", () => {
    for (const t of templates) {
      expect(t.capabilities.webhooks).toBe(t.capabilities.webhook_events.length > 0);
    }
  });
});
