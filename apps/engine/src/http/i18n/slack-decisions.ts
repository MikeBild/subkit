export type SlackDecisionLocale = "de" | "en";

export interface SlackDecisionCopy {
  approve: string;
  decline: string;
  open: string;
  link: string;
  heldRunTitle: (task: string | null) => string;
  heldRunDetail: (tool: string) => string;
  resultReadyTitle: (task: string | null) => string;
  workflowApprovalTitle: (workflow: string | null) => string;
  decideInSubkit: string;
  approvedBy: (who: string, when: string) => string;
  declinedBy: (who: string, when: string) => string;
  alreadyApproved: (who: string | null) => string;
  alreadyDeclined: string;
  alreadyUsed: string;
  expired: string;
  notFound: string;
  notLinked: string;
  forbidden: string;
  ownership: string;
  failed: string;
  page: {
    context: string;
    title: string;
    line: (slackUser: string, team: string, email: string) => string;
    confirm: string;
    linkedTitle: string;
    linkedLine: string;
    deadTitle: string;
    deadLine: string;
    alreadyTitle: string;
    alreadyLine: string;
    refusedTitle: string;
    refusedLine: string;
  };
}

export const SLACK_DECISION_COPY: Record<SlackDecisionLocale, SlackDecisionCopy> = {
  en: {
    approve: "Approve",
    decline: "Decline",
    open: "Open in SubKit",
    link: "Link Slack account",
    heldRunTitle: (task) =>
      task
        ? `A run of “${task}” is waiting for your approval`
        : "A run is waiting for your approval",
    heldRunDetail: (tool) => `Action: ${tool}`,
    resultReadyTitle: (task) =>
      task
        ? `The result of “${task}” is waiting for you to confirm it`
        : "A result is waiting for you to confirm it",
    workflowApprovalTitle: (workflow) =>
      workflow ? `The approval for “${workflow}” expires soon` : "A workflow approval expires soon",
    decideInSubkit: "You make this decision in SubKit.",
    approvedBy: (who, when) => `Approved by ${who} · ${when}`,
    declinedBy: (who, when) => `Declined by ${who} · ${when}`,
    alreadyApproved: (who) => (who ? `Already approved by ${who}.` : "Already approved."),
    alreadyDeclined: "Already declined.",
    alreadyUsed: "Already decided and carried out.",
    expired: "The deadline has passed. Nothing was changed.",
    notFound: "This decision is no longer open. Nothing was changed.",
    notLinked:
      "Your Slack account is not linked to SubKit yet. Link it once, then you decide right here. You can also open the decision in SubKit.",
    forbidden: "You don’t have permission to decide this. Nothing was changed.",
    ownership: "This Slack workspace is not verified yet. Make the decision in SubKit.",
    failed: "That didn’t work. Nothing was changed. Open the decision in SubKit.",
    page: {
      context: "Slack",
      title: "Link your Slack account",
      line: (slackUser, team, email) =>
        `Link the Slack account ${slackUser} in workspace ${team} to your SubKit account ${email}?`,
      confirm: "Link account",
      linkedTitle: "Slack account linked",
      linkedLine: "You can now make decisions right in Slack.",
      deadTitle: "Link expired",
      deadLine: "Click a decision in Slack again to get a new link.",
      alreadyTitle: "Already linked",
      alreadyLine:
        "This Slack account is already linked to a SubKit account. An admin can remove the link.",
      refusedTitle: "Link refused",
      refusedLine:
        "This link belongs to another workspace or the Slack workspace is not connected. Nothing was changed.",
    },
  },
  de: {
    approve: "Freigeben",
    decline: "Ablehnen",
    open: "In SubKit öffnen",
    link: "Slack-Konto verknüpfen",
    heldRunTitle: (task) =>
      task
        ? `Ein Lauf von „${task}“ wartet auf deine Freigabe`
        : "Ein Lauf wartet auf deine Freigabe",
    heldRunDetail: (tool) => `Aktion: ${tool}`,
    resultReadyTitle: (task) =>
      task
        ? `Das Ergebnis von „${task}“ wartet auf deine Bestätigung`
        : "Ein Ergebnis wartet auf deine Bestätigung",
    workflowApprovalTitle: (workflow) =>
      workflow
        ? `Die Freigabe für „${workflow}“ läuft bald ab`
        : "Eine Workflow-Freigabe läuft bald ab",
    decideInSubkit: "Diese Entscheidung triffst du in SubKit.",
    approvedBy: (who, when) => `Freigegeben von ${who} · ${when}`,
    declinedBy: (who, when) => `Abgelehnt von ${who} · ${when}`,
    alreadyApproved: (who) => (who ? `Bereits freigegeben von ${who}.` : "Bereits freigegeben."),
    alreadyDeclined: "Bereits abgelehnt.",
    alreadyUsed: "Bereits entschieden und ausgeführt.",
    expired: "Die Frist ist abgelaufen. Geändert wurde nichts.",
    notFound: "Diese Entscheidung steht nicht mehr an. Geändert wurde nichts.",
    notLinked:
      "Dein Slack-Konto ist noch nicht mit SubKit verknüpft. Verknüpfe es einmal, dann entscheidest du direkt hier. Du kannst die Entscheidung auch in SubKit öffnen.",
    forbidden: "Dir fehlt die Berechtigung, das zu entscheiden. Geändert wurde nichts.",
    ownership: "Dieser Slack-Workspace ist noch nicht bestätigt. Entscheide in SubKit.",
    failed: "Das hat nicht geklappt. Geändert wurde nichts. Öffne die Entscheidung in SubKit.",
    page: {
      context: "Slack",
      title: "Slack-Konto verknüpfen",
      line: (slackUser, team, email) =>
        `Das Slack-Konto ${slackUser} im Workspace ${team} mit deinem SubKit-Konto ${email} verknüpfen?`,
      confirm: "Konto verknüpfen",
      linkedTitle: "Slack-Konto verknüpft",
      linkedLine: "Du kannst Entscheidungen jetzt direkt in Slack treffen.",
      deadTitle: "Link abgelaufen",
      deadLine: "Klicke in Slack erneut auf eine Entscheidung, um einen neuen Link zu bekommen.",
      alreadyTitle: "Bereits verknüpft",
      alreadyLine:
        "Dieses Slack-Konto ist schon mit einem SubKit-Konto verknüpft. Eine Administratorin oder ein Administrator kann die Verknüpfung lösen.",
      refusedTitle: "Verknüpfung abgelehnt",
      refusedLine:
        "Dieser Link gehört zu einem anderen Workspace, oder der Slack-Workspace ist nicht verbunden. Geändert wurde nichts.",
    },
  },
};

export function slackDecisionCopy(locale: string | null | undefined): SlackDecisionCopy {
  return SLACK_DECISION_COPY[locale === "de" ? "de" : "en"];
}
