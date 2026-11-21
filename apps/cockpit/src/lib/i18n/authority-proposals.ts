export const authorityProposalsEn = {
  "authorityProposals.action.open": "Set limits",
  "authorityProposals.title": "Suggested limits",
  "authorityProposals.help":
    "A limit says where a step may send or store something and how much, SubKit reads it from earlier runs, and nothing is saved until you apply it.",
  "authorityProposals.summary.one":
    "SubKit suggests a limit for 1 step from its earlier runs, so check it and apply it.",
  "authorityProposals.summary.other":
    "SubKit suggests limits for {count} steps from their earlier runs, so check them and apply them.",
  "authorityProposals.apply": "Apply limits",
  "authorityProposals.applying": "Saving limits…",
  "authorityProposals.creates": "Applying saves {version}, which you review next.",
  "authorityProposals.applied": "The limits are saved, so review the new version now.",
  "authorityProposals.failed": "The limits could not be saved, so try again.",
  "authorityProposals.untried.one":
    "1 step has no earlier run to read, so start a trial run, which holds back every write.",
  "authorityProposals.untried.other":
    "{count} steps have no earlier run to read, so start a trial run, which holds back every write.",
  "authorityProposals.trial.start": "Start trial run",
  "authorityProposals.trial.what":
    "A trial run reads from your connected systems for real and holds back every request that would change something, so start it to let SubKit work out the limits.",
  "authorityProposals.remaining.one":
    "1 step needs a change SubKit cannot work out, so fix it in the chat.",
  "authorityProposals.remaining.other":
    "{count} steps need a change SubKit cannot work out, so fix them in the chat.",
  "authorityProposals.evidence.one": "Worked out from 1 earlier request.",
  "authorityProposals.evidence.other": "Worked out from {count} earlier requests.",
  "authorityProposals.reason.no_history":
    "No earlier run of this step was found, so start a trial run.",
  "authorityProposals.reason.body_size_unknown":
    "No earlier run shows how much this step sends, so start a trial run.",
  "authorityProposals.reason.path_not_comparable":
    "The address of this step cannot be compared with its earlier runs, so set its limit in the chat.",
  "authorityProposals.reason.values_not_describable":
    "The values this step used cannot be stated as a short list or a known form, so set its limit in the chat.",
  "authorityProposals.reason.not_supported":
    "This kind of step cannot get a suggested limit, so adjust it in the chat.",
  "authorityProposals.reason.still_refused":
    "A suggested limit would still be refused for this step, so adjust the step in the chat.",
  "authorityProposals.technical.sample": "Target: {sample}",
  "authorityProposals.reason.sensitive_value":
    "This step puts a secret into its address, so move it into the connector’s sign-in in the chat.",
  "authorityProposals.host": "Address: {host}",
  "authorityProposals.rewrite":
    "SubKit also moves the fixed parts after the question mark out of the address into fields of their own, which changes nothing about the request.",
  "authorityProposals.widens.key_prefix": "This widens the folder from {from} to {to}.",
  "authorityProposals.widens.max_bytes": "This widens the size limit from {from} to {to} bytes.",
  "authorityProposals.evidence.trial.one":
    "Worked out from 1 request of a trial run, which was not sent.",
  "authorityProposals.evidence.trial.other":
    "Worked out from {count} requests of a trial run, which were not sent.",
  "authorityProposals.trial.notStarted":
    "The trial run did not start because nothing is left for it to try, so fix the remaining steps in the chat.",
  "authorityProposals.listedValues":
    "The values listed here are saved in the workflow, so check them before you approve it.",
} as const;

export const authorityProposalsDe: Record<keyof typeof authorityProposalsEn, string> = {
  "authorityProposals.action.open": "Grenzen festlegen",
  "authorityProposals.title": "Vorgeschlagene Grenzen",
  "authorityProposals.help":
    "Eine Grenze legt fest, wohin ein Schritt senden oder speichern darf und wie viel, SubKit liest sie aus früheren Runs, und gespeichert wird erst, wenn du sie übernimmst.",
  "authorityProposals.summary.one":
    "SubKit schlägt aus früheren Runs eine Grenze für 1 Schritt vor, prüfe sie und übernimm sie.",
  "authorityProposals.summary.other":
    "SubKit schlägt aus früheren Runs Grenzen für {count} Schritte vor, prüfe sie und übernimm sie.",
  "authorityProposals.apply": "Grenzen übernehmen",
  "authorityProposals.applying": "Grenzen werden gespeichert …",
  "authorityProposals.creates": "Beim Übernehmen entsteht {version}, die du als Nächstes prüfst.",
  "authorityProposals.applied": "Die Grenzen sind gespeichert, prüfe jetzt die neue Version.",
  "authorityProposals.failed":
    "Die Grenzen konnten nicht gespeichert werden, versuche es noch einmal.",
  "authorityProposals.untried.one":
    "Für 1 Schritt gibt es keinen früheren Run, starte deshalb einen Probe-Run, der jeden Schreibzugriff zurückhält.",
  "authorityProposals.untried.other":
    "Für {count} Schritte gibt es keinen früheren Run, starte deshalb einen Probe-Run, der jeden Schreibzugriff zurückhält.",
  "authorityProposals.trial.start": "Probe-Run starten",
  "authorityProposals.trial.what":
    "Ein Probe-Run liest wirklich aus deinen verbundenen Systemen und hält jede Anfrage zurück, die etwas ändern würde, starte ihn, damit SubKit die Grenzen herleiten kann.",
  "authorityProposals.remaining.one":
    "1 Schritt braucht eine Änderung, die SubKit nicht herleiten kann, behebe sie im Chat.",
  "authorityProposals.remaining.other":
    "{count} Schritte brauchen eine Änderung, die SubKit nicht herleiten kann, behebe sie im Chat.",
  "authorityProposals.evidence.one": "Aus 1 früheren Anfrage hergeleitet.",
  "authorityProposals.evidence.other": "Aus {count} früheren Anfragen hergeleitet.",
  "authorityProposals.reason.no_history":
    "Für diesen Schritt gibt es keinen früheren Run, starte deshalb einen Probe-Run.",
  "authorityProposals.reason.body_size_unknown":
    "Kein früherer Run zeigt, wie viel dieser Schritt sendet, starte deshalb einen Probe-Run.",
  "authorityProposals.reason.path_not_comparable":
    "Die Adresse dieses Schritts lässt sich nicht mit seinen früheren Runs vergleichen, lege seine Grenze deshalb im Chat fest.",
  "authorityProposals.reason.values_not_describable":
    "Die Werte dieses Schritts lassen sich weder als kurze Liste noch als bekannte Form angeben, lege seine Grenze deshalb im Chat fest.",
  "authorityProposals.reason.not_supported":
    "Für diese Art von Schritt gibt es keinen Vorschlag, passe ihn deshalb im Chat an.",
  "authorityProposals.reason.still_refused":
    "Auch mit einer vorgeschlagenen Grenze würde dieser Schritt abgelehnt, passe ihn deshalb im Chat an.",
  "authorityProposals.technical.sample": "Ziel: {sample}",
  "authorityProposals.reason.sensitive_value":
    "Dieser Schritt schreibt ein Geheimnis in seine Adresse, verlege es im Chat in die Anmeldung des Connectors.",
  "authorityProposals.host": "Adresse: {host}",
  "authorityProposals.rewrite":
    "SubKit verschiebt außerdem die festen Angaben hinter dem Fragezeichen aus der Adresse in eigene Felder, was an der Anfrage nichts ändert.",
  "authorityProposals.widens.key_prefix": "Das erweitert den Ordner von {from} auf {to}.",
  "authorityProposals.widens.max_bytes":
    "Das erweitert die Größengrenze von {from} auf {to} Bytes.",
  "authorityProposals.evidence.trial.one":
    "Aus 1 Anfrage eines Probe-Runs hergeleitet, die nicht gesendet wurde.",
  "authorityProposals.evidence.trial.other":
    "Aus {count} Anfragen eines Probe-Runs hergeleitet, die nicht gesendet wurden.",
  "authorityProposals.trial.notStarted":
    "Der Probe-Run ist nicht gestartet, weil es für ihn nichts mehr zu prüfen gibt, behebe die übrigen Schritte im Chat.",
  "authorityProposals.listedValues":
    "Die hier aufgeführten Werte werden im Workflow gespeichert, prüfe sie deshalb, bevor du ihn freigibst.",
};
