import { randomUUID } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sessionLearningFixture(suffix) {
  if (!/^[a-f0-9]{8}$/.test(suffix)) throw new Error("Session learning fixture suffix is invalid");
  const label = `session-learning-${suffix}`;
  return {
    label,
    category: `journey-${suffix}`,
    supersededTitle: `${label} alte Regel`,
    skillTitle: `${label} Regel`,
    marker: `Synthetische Regel ${label}`,
  };
}

export function proposalCitesOnly(proposal, itemIds) {
  const cited = (proposal?.revision?.items ?? []).map((item) => item.id);
  return cited.length > 0 && cited.every((id) => itemIds.includes(id));
}

export async function cleanupSessionLearningFixtures(fixtures, api) {
  const cleanup = { deleted: [], discarded: [], rejected: [], retained: [], failures: [] };
  const attempt = async (label, action) => {
    try {
      await action();
    } catch (error) {
      cleanup.failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  for (const id of fixtures.conversationIds)
    await attempt(`conversation ${id}`, async () => {
      await api.remove(`/v1/conversations/${id}`);
      cleanup.deleted.push(id);
    });
  for (const id of fixtures.proposalIds)
    await attempt(`proposal ${id}`, async () => {
      const proposal = await api.read(`/v1/intake/proposals/${id}`);
      if (proposal.status === "draft" || proposal.status === "stale") {
        await api.write(`/v1/intake/proposals/${id}/reject`, "POST", {
          expected_revision: proposal.current_revision,
        });
        cleanup.rejected.push(id);
      } else cleanup.retained.push(id);
    });
  for (const id of fixtures.skillIds)
    await attempt(`skill ${id}`, async () => {
      await api.remove(`/v1/skills/${id}`);
      cleanup.deleted.push(id);
    });
  for (const id of fixtures.itemIds)
    await attempt(`intake item ${id}`, async () => {
      const item = await api.read(`/v1/intake/items/${id}`);
      if (item.state === "collected" || item.state === "reviewing") {
        await api.write(`/v1/intake/items/${id}`, "PATCH", {
          state: "discarded",
          expected_version: item.version,
        });
        cleanup.discarded.push(id);
      } else cleanup.retained.push(id);
    });
  return cleanup;
}

export function targetReachesDomain(target, domain) {
  if (!target || typeof target !== "object") return false;
  if ("skill" in target) {
    const created = target.skill?.new;
    return created
      ? (created.tags ?? []).includes(`domain:${domain}`)
      : Boolean(target.skill?.skill_id);
  }
  if ("knowledge_source_id" in target) return true;
  return (
    target.name === `Knowledge · ${domain}` && (target.tags ?? []).includes(`domain:${domain}`)
  );
}

export async function verifySessionLearningReview({
  page,
  request,
  origin,
  sessionHeaders,
  writeHeaders,
  apiKey,
  mockChat,
}) {
  const fixture = sessionLearningFixture(randomUUID().replaceAll("-", "").slice(0, 8));
  const fixtures = { itemIds: [], proposalIds: [], skillIds: [], conversationIds: [] };
  const result = {
    label: fixture.label,
    category: fixture.category,
    deterministic: { checks: [], passed: false },
    model: mockChat
      ? { mode: "skipped", reason: "mock chat cannot judge collected material", checks: [] }
      : { mode: "provider", checks: [], passed: false },
    fixtures,
    cleanup: null,
    passed: false,
  };
  const errors = [];
  const call = async (method, path, data, statuses = [200, 201]) => {
    const response = await request.fetch(`${origin}${path}`, {
      method,
      headers: { ...sessionHeaders, ...(method === "GET" ? {} : writeHeaders) },
      ...(data === undefined ? {} : { data }),
      timeout: 180_000,
    });
    if (!statuses.includes(response.status()))
      throw new Error(`${method} ${path}: HTTP ${response.status()}`);
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  };
  const api = {
    read: (path) => call("GET", path),
    write: (path, method, data) => call(method, path, data),
    remove: (path) => call("DELETE", path, undefined, [200, 204, 404]),
  };
  const check = (section, name, condition) => {
    if (!condition) throw new Error(`Session learning review: ${name}`);
    section.checks.push(name);
  };
  const own = (list, id) => {
    if (typeof id !== "string" || !UUID.test(id)) throw new Error("Created fixture ID missing");
    list.push(id);
    return id;
  };
  const collect = async (title, body) =>
    own(
      fixtures.itemIds,
      (
        await api.write("/v1/intake/items", "POST", {
          client_request_id: randomUUID(),
          category: fixture.category,
          title,
          source_url: `https://example.invalid/${fixture.label}/${encodeURIComponent(title)}`,
          captured_at: new Date().toISOString(),
          body,
        })
      ).id,
    );

  try {
    const deterministic = result.deterministic;
    const superseded = own(
      fixtures.skillIds,
      (
        await api.write("/v1/skills", "POST", {
          scope: "global",
          title: fixture.supersededTitle,
          body: "Temporäre lokale Regel, die durch die bestätigte Regel ersetzt wird.",
          description: "Disposable session learning journey",
          category: "demo",
          status: "draft",
          applies_to: "chat",
        })
      ).id,
    );
    await api.write(`/v1/skills/${superseded}/activate`, "POST");
    const supersededVersion = (await api.read(`/v1/skills/${superseded}`)).version;
    const itemId = await collect(
      `${fixture.label} Hinweis`,
      `${fixture.marker}: Störungen zuerst nach Wirkung einordnen.`,
    );
    check(deterministic, "fixture-collected-in-dedicated-category", true);

    const search = await api.read(
      `/v1/knowledge-sources/search?q=${encodeURIComponent(fixture.marker)}`,
    );
    const skills = await api.read(`/v1/skills?q=${encodeURIComponent(fixture.label)}&limit=500`);
    const briefing = await api.read(
      `/v1/agent/briefing?domains=${encodeURIComponent(fixture.category)}`,
    );
    check(
      deterministic,
      "no-knowledge-skill-or-briefing-hit-before-confirmation",
      !(search.hits ?? []).some((hit) => JSON.stringify(hit).includes(fixture.label)) &&
        !(skills.items ?? []).some((skill) => skill.title === fixture.skillTitle) &&
        !String(briefing.markdown ?? "").includes(fixture.marker),
    );

    const proposal = await api.write("/v1/intake/proposals", "POST", {
      item_ids: [itemId],
      title: fixture.skillTitle,
      body: "Ordne jede Störung zuerst nach Wirkung ein, bevor du Ursachen suchst.",
      target: {
        skill: {
          new: {
            title: fixture.skillTitle,
            scope: "global",
            tags: [`domain:${fixture.category}`],
            category: "demo",
          },
          supersedes: [{ skill_id: superseded, expected_version: supersededVersion }],
        },
      },
    });
    const proposalId = own(fixtures.proposalIds, proposal.id);
    check(deterministic, "proposal-cites-only-the-fixture", proposalCitesOnly(proposal, [itemId]));

    const refused = await fetch(`${origin}/v1/intake/proposals/${proposalId}/confirm`, {
      method: "POST",
      redirect: "error",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        expected_revision: proposal.current_revision,
        digest: proposal.revision.digest,
      }),
    });
    const refusal = await refused.json().catch(() => ({}));
    const stillDraft = await api.read(`/v1/intake/proposals/${proposalId}`);
    check(
      deterministic,
      "api-key-cannot-confirm",
      refused.status === 403 &&
        refusal.code === "human_confirmation_required" &&
        stillDraft.status === "draft",
    );

    await page.goto(`${origin}/cockpit/intake?proposal=${proposalId}`);
    await page.getByTestId(`intake-proposal-${proposalId}-confirm`).click();
    await page.getByTestId(`intake-proposal-${proposalId}-confirm-dialog-confirm`).click();
    await page.getByTestId(`intake-proposal-${proposalId}-skill`).waitFor({ state: "visible" });
    const confirmed = await api.read(`/v1/intake/proposals/${proposalId}`);
    const createdSkill = own(fixtures.skillIds, confirmed.confirmed_target_id);
    check(
      deterministic,
      "cockpit-confirmation-admits-a-skill",
      confirmed.status === "confirmed" && confirmed.confirmed_target_kind === "skill",
    );

    const repeated = await api.write(`/v1/intake/proposals/${proposalId}/confirm`, "POST", {
      expected_revision: proposal.current_revision,
      digest: proposal.revision.digest,
    });
    const afterSkills = await api.read(
      `/v1/skills?q=${encodeURIComponent(fixture.label)}&limit=500`,
    );
    const active = await api.read(`/v1/skills/${createdSkill}`);
    const replaced = await api.read(`/v1/skills/${superseded}`);
    check(
      deterministic,
      "exactly-one-active-skill-and-replaced-skill-archived",
      repeated.confirmed_target_id === createdSkill &&
        (afterSkills.items ?? []).filter((skill) => skill.title === fixture.skillTitle).length ===
          1 &&
        active.status === "active" &&
        replaced.status === "archived",
    );
    const confirmedBriefing = await api.read(
      `/v1/agent/briefing?domains=${encodeURIComponent(fixture.category)}`,
    );
    check(
      deterministic,
      "confirmed-skill-discoverable-in-domain-briefing-without-clip-body",
      [...(confirmedBriefing.skills_full ?? []), ...(confirmedBriefing.skills_title_only ?? [])]
        .map(String)
        .includes(String(active.slug ?? active.title)) &&
        !String(confirmedBriefing.markdown ?? "").includes(fixture.marker),
    );
    const admitted = await api.read(`/v1/intake/items/${itemId}`);
    check(
      deterministic,
      "item-provenance-points-to-the-skill",
      admitted.state === "admitted" &&
        admitted.admitted_target_kind === "skill" &&
        admitted.admitted_target_id === createdSkill &&
        String(admitted.original_snapshot?.source_url).includes(fixture.label),
    );
    deterministic.passed = true;

    if (!mockChat) {
      const model = result.model;
      const reviewed = [
        await collect(
          `${fixture.label} Beobachtung A`,
          `${fixture.marker}: Vor jedem Neustart den Fehlerzähler notieren.`,
        ),
        await collect(
          `${fixture.label} Beobachtung B`,
          `${fixture.marker}: Den Fehlerzähler vor dem Neustart festhalten.`,
        ),
      ];
      const conversation = await api.write("/v1/conversations", "POST", {
        intake_item_ids: reviewed,
        initial_message:
          "Konsolidiere diese gesammelten Sitzungs-Lernvorschläge. Lies jeden Eintrag und lege genau einen Vorschlag als Skill oder Wissen an, der nur diese Einträge als Quelle nennt.",
      });
      own(fixtures.conversationIds, conversation.conversation?.id);
      const proposals = await api.read("/v1/intake/proposals");
      const created = (proposals.items ?? []).filter((candidate) =>
        (candidate.revision?.items ?? []).some((item) => reviewed.includes(item.id)),
      );
      for (const candidate of created) own(fixtures.proposalIds, candidate.id);
      model.proposals = created.map((candidate) => ({
        id: candidate.id,
        target_kind: "skill" in (candidate.revision?.target ?? {}) ? "skill" : "knowledge",
        cited: candidate.revision.items.map((item) => item.id),
      }));
      check(model, "real-model-created-a-proposal", created.length > 0);
      check(
        model,
        "real-model-proposal-cites-only-read-fixtures",
        created.every((candidate) => proposalCitesOnly(candidate, reviewed)),
      );
      check(
        model,
        "real-model-target-reaches-the-fixture-domain",
        created.every((candidate) =>
          targetReachesDomain(candidate.revision?.target, fixture.category),
        ),
      );
      const items = await Promise.all(reviewed.map((id) => api.read(`/v1/intake/items/${id}`)));
      check(
        model,
        "nothing-admitted-without-a-person",
        created.every((candidate) => candidate.status === "draft") &&
          items.every((item) => item.state !== "admitted"),
      );
      model.passed = true;
    }
    result.passed = true;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    result.cleanup = await cleanupSessionLearningFixtures(fixtures, api);
    errors.push(...result.cleanup.failures);
  }
  return { result, errors };
}
