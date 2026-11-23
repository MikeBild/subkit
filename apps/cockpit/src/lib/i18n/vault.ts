export const vaultEn = {
  "settings.area.vault.title": "Vault",
  "vault.intro":
    "API keys, tokens and logins for your workflows. A workflow uses an entry by its handle, and the value never shows up in a run.",
  "vault.add": "Add entry",
  "vault.filter.label": "Whose entries",
  "vault.search": "Search entries",
  "vault.noMatch": "Nothing found for “{search}”.",
  "vault.scope.workspace": "Workspace",
  "vault.scope.person": "Only me",
  "vault.kind.secret": "API key or token",
  "vault.kind.login": "Login",
  "vault.kind.connector": "Connector access",
  "vault.kind.template_client": "Template client",
  "vault.version": "Version {version}",
  "vault.lastUsed": "Last used {when}",
  "vault.neverUsed": "Never used",
  "vault.empty.title": "The vault is empty",
  "vault.empty.body":
    "Add an API key or a login. Your workflows then use it by its handle, for example {handle}, and never see the value.",
  "vault.empty.person": "You have no personal entries yet. Add one and choose “Only me”.",
  "vault.empty.workspace":
    "This workspace has no shared entries yet. Add one and choose “Workspace”.",
  "vault.empty.workspaceReadOnly":
    "There are no shared entries you can see. Your own entries are under “Only me”.",
  "vault.loadFailed": "The vault couldn’t be loaded. Try again.",
  "vault.add.title": "Add entry",
  "vault.add.description": "The value is stored encrypted. Workflows only see the handle.",
  "vault.add.submit": "Add",
  "vault.added": "{name} added",
  "vault.field.kind": "What do you want to store?",
  "vault.field.name": "Name",
  "vault.field.nameHelp":
    "Lowercase letters, digits, hyphen and underscore. Workflows use the name in the handle.",
  "vault.field.handlePreview": "Handle: {handle}",
  "vault.field.scope": "Who can use it?",
  "vault.field.scopeReadOnly":
    "Shared entries need the right to change the vault. You can always add your own.",
  "vault.field.environment": "Environment",
  "vault.field.description": "Description (optional)",
  "vault.field.token": "API key or token",
  "vault.field.tokenHelp":
    "Paste multi-line values such as an SSH private key as they are. Line breaks are kept.",
  "vault.field.username": "Username",
  "vault.field.password": "Password",
  "vault.name.empty": "Enter a name, for example crm-token.",
  "vault.name.invalid":
    "Use lowercase letters, digits, hyphen and underscore. The name starts with a letter or digit and has at most 63 characters.",
  "vault.name.reserved": "“me” is reserved for personal handles. Choose another name.",
  "vault.value.missingToken": "Enter the API key or token.",
  "vault.value.missingLogin": "Enter username and password.",
  "vault.detail.kind": "Kind",
  "vault.detail.scope": "Who can use it",
  "vault.detail.environment": "Environment",
  "vault.detail.version": "Version",
  "vault.detail.lastUsed": "Last used",
  "vault.detail.created": "Added",
  "vault.detail.rotated": "Value replaced",
  "vault.detail.description": "Description",
  "vault.detail.handle": "Handle",
  "vault.detail.handleFor": "Handle for {field}",
  "vault.reveal": "Reveal",
  "vault.reveal.note": "Every reveal is recorded.",
  "vault.reveal.hidesIn": "Hidden again in {seconds}\u00a0s",
  "vault.reveal.hide": "Hide",
  "vault.reveal.value": "Value of {field}",
  "vault.rotate": "Replace value",
  "vault.rotate.title": "Replace value of {name}",
  "vault.rotate.description":
    "Workflows use the new value from their next run on. The old value can’t be restored.",
  "vault.rotate.submit": "Replace",
  "vault.rotated": "{name} has a new value",
  "vault.delete": "Delete",
  "vault.delete.consequence":
    "Workflows that use {handle} fail until you add a new entry with this name. This can’t be undone.",
  "vault.delete.connectorConsequence":
    "The connector loses its sign-in. Its runs fail until someone signs in again on the connector. This can’t be undone.",
  "vault.delete.templateConsequence":
    "Connectors from the template {template} can’t sign in until the client is set up again in the template. This can’t be undone.",
  "vault.deleted": "{name} deleted",
  "vault.connector.open": "Open connector {name}",
  "vault.connector.note": "This access belongs to the connector. Change it there.",
  "vault.template.note":
    "This client belongs to the connector template {template} and is changed there.",
  "vault.activity.title": "Activity",
  "vault.activity.empty": "Nothing recorded yet.",
  "vault.activity.loadFailed": "The activity couldn’t be loaded. Try again.",
  "vault.error.forbidden":
    "You don’t have the right for this. Ask someone who manages roles in this workspace.",
  "vault.error.notFound": "This entry no longer exists. Reload the list.",
  "vault.error.exists":
    "An entry with this name already exists in this environment. Choose another name.",
  "vault.error.unreadable":
    "This entry can’t be opened with the current key. Replace the value, or delete the entry and add it again.",
  "vault.error.unreadableConnector":
    "This access can’t be opened with the current key. Sign in again on the connector.",
  "vault.error.unreadableTemplate":
    "This client can’t be opened with the current key. Set it up again in the connector template.",
  "vault.error.invalid": "The entry wasn’t accepted. Check name and values, then try again.",
  "vault.error.generic": "That didn’t work. Try again in a moment.",
} as const;

export const vaultDe: Record<keyof typeof vaultEn, string> = {
  "settings.area.vault.title": "Tresor",
  "vault.intro":
    "API-Keys, Tokens und Logins für deine Workflows. Ein Workflow nutzt einen Eintrag über seinen Handle, der Wert taucht in keinem Run auf.",
  "vault.add": "Eintrag hinzufügen",
  "vault.filter.label": "Wessen Einträge",
  "vault.search": "Einträge durchsuchen",
  "vault.noMatch": "Nichts gefunden für „{search}“.",
  "vault.scope.workspace": "Arbeitsbereich",
  "vault.scope.person": "Nur ich",
  "vault.kind.secret": "API-Key oder Token",
  "vault.kind.login": "Login",
  "vault.kind.connector": "Connector-Zugang",
  "vault.kind.template_client": "Template-Client",
  "vault.version": "Version {version}",
  "vault.lastUsed": "Zuletzt genutzt {when}",
  "vault.neverUsed": "Noch nie genutzt",
  "vault.empty.title": "Der Tresor ist leer",
  "vault.empty.body":
    "Füge einen API-Key oder einen Login hinzu. Deine Workflows nutzen ihn dann über seinen Handle, zum Beispiel {handle}, und sehen den Wert nie.",
  "vault.empty.person":
    "Du hast noch keine eigenen Einträge. Füge einen hinzu und wähle „Nur ich“.",
  "vault.empty.workspace":
    "Dieser Arbeitsbereich hat noch keine gemeinsamen Einträge. Füge einen hinzu und wähle „Arbeitsbereich“.",
  "vault.empty.workspaceReadOnly":
    "Es gibt keine gemeinsamen Einträge, die du sehen kannst. Deine eigenen Einträge findest du unter „Nur ich“.",
  "vault.loadFailed": "Der Tresor konnte nicht geladen werden. Versuch es noch einmal.",
  "vault.add.title": "Eintrag hinzufügen",
  "vault.add.description":
    "Der Wert wird verschlüsselt gespeichert. Workflows sehen nur den Handle.",
  "vault.add.submit": "Hinzufügen",
  "vault.added": "{name} hinzugefügt",
  "vault.field.kind": "Was möchtest du ablegen?",
  "vault.field.name": "Name",
  "vault.field.nameHelp":
    "Kleinbuchstaben, Ziffern, Bindestrich und Unterstrich. Workflows nutzen den Namen im Handle.",
  "vault.field.handlePreview": "Handle: {handle}",
  "vault.field.scope": "Wer darf ihn nutzen?",
  "vault.field.scopeReadOnly":
    "Gemeinsame Einträge brauchen das Recht, den Tresor zu ändern. Eigene Einträge kannst du immer anlegen.",
  "vault.field.environment": "Umgebung",
  "vault.field.description": "Beschreibung (optional)",
  "vault.field.token": "API-Key oder Token",
  "vault.field.tokenHelp":
    "Mehrzeilige Werte wie einen privaten SSH-Key fügst du unverändert ein. Die Zeilenumbrüche bleiben erhalten.",
  "vault.field.username": "Benutzername",
  "vault.field.password": "Passwort",
  "vault.name.empty": "Gib einen Namen ein, zum Beispiel crm-token.",
  "vault.name.invalid":
    "Nutze Kleinbuchstaben, Ziffern, Bindestrich und Unterstrich. Der Name beginnt mit einem Buchstaben oder einer Ziffer und hat höchstens 63 Zeichen.",
  "vault.name.reserved": "„me“ ist für persönliche Handles reserviert. Wähle einen anderen Namen.",
  "vault.value.missingToken": "Gib den API-Key oder Token ein.",
  "vault.value.missingLogin": "Gib Benutzername und Passwort ein.",
  "vault.detail.kind": "Art",
  "vault.detail.scope": "Wer ihn nutzen darf",
  "vault.detail.environment": "Umgebung",
  "vault.detail.version": "Version",
  "vault.detail.lastUsed": "Zuletzt genutzt",
  "vault.detail.created": "Hinzugefügt",
  "vault.detail.rotated": "Wert ersetzt",
  "vault.detail.description": "Beschreibung",
  "vault.detail.handle": "Handle",
  "vault.detail.handleFor": "Handle für {field}",
  "vault.reveal": "Aufdecken",
  "vault.reveal.note": "Jedes Aufdecken wird protokolliert.",
  "vault.reveal.hidesIn": "Wird in {seconds}\u00a0s wieder verborgen",
  "vault.reveal.hide": "Verbergen",
  "vault.reveal.value": "Wert von {field}",
  "vault.rotate": "Wert ersetzen",
  "vault.rotate.title": "Wert von {name} ersetzen",
  "vault.rotate.description":
    "Workflows nutzen den neuen Wert ab ihrem nächsten Run. Der alte Wert lässt sich nicht wiederherstellen.",
  "vault.rotate.submit": "Ersetzen",
  "vault.rotated": "{name} hat einen neuen Wert",
  "vault.delete": "Löschen",
  "vault.delete.consequence":
    "Workflows, die {handle} nutzen, schlagen fehl, bis du einen neuen Eintrag mit diesem Namen anlegst. Das lässt sich nicht rückgängig machen.",
  "vault.delete.connectorConsequence":
    "Der Connector verliert seine Anmeldung. Seine Runs schlagen fehl, bis sich jemand am Connector neu anmeldet. Das lässt sich nicht rückgängig machen.",
  "vault.delete.templateConsequence":
    "Connectors aus der Vorlage {template} können sich nicht mehr anmelden, bis der Client in der Vorlage neu eingerichtet ist. Das lässt sich nicht rückgängig machen.",
  "vault.deleted": "{name} gelöscht",
  "vault.connector.open": "Connector {name} öffnen",
  "vault.connector.note": "Dieser Zugang gehört zum Connector. Ändere ihn dort.",
  "vault.template.note":
    "Dieser Client gehört zur Connector-Vorlage {template} und wird dort geändert.",
  "vault.activity.title": "Verlauf",
  "vault.activity.empty": "Noch nichts aufgezeichnet.",
  "vault.activity.loadFailed": "Der Verlauf konnte nicht geladen werden. Versuch es noch einmal.",
  "vault.error.forbidden":
    "Dafür fehlt dir das Recht. Frag jemanden, der die Rollen in diesem Arbeitsbereich verwaltet.",
  "vault.error.notFound": "Diesen Eintrag gibt es nicht mehr. Lade die Liste neu.",
  "vault.error.exists":
    "Einen Eintrag mit diesem Namen gibt es in dieser Umgebung schon. Wähle einen anderen Namen.",
  "vault.error.unreadable":
    "Dieser Eintrag lässt sich mit dem aktuellen Schlüssel nicht öffnen. Ersetze den Wert oder lösche den Eintrag und lege ihn neu an.",
  "vault.error.unreadableConnector":
    "Dieser Zugang lässt sich mit dem aktuellen Schlüssel nicht öffnen. Melde dich am Connector neu an.",
  "vault.error.unreadableTemplate":
    "Dieser Client lässt sich mit dem aktuellen Schlüssel nicht öffnen. Richte ihn in der Connector-Vorlage neu ein.",
  "vault.error.invalid":
    "Der Eintrag wurde nicht angenommen. Prüf Name und Werte und versuch es noch einmal.",
  "vault.error.generic": "Das hat nicht geklappt. Versuch es gleich noch einmal.",
};
