export const authorityEn = {
  "authority.namedTitle": "Approve {name} {version}",
  "authority.subject.issues": "Issues",
  "authority.subject.comments": "Comments",
  "authority.subject.commits": "Commits",
  "authority.subject.pulls": "Pull requests",
  "authority.subject.repos": "Repositories",
  "authority.subject.ref": "Branch state",
  "authority.subject.contents": "Repository files",
  "authority.subject.messages": "Messages",
  "authority.subject.files": "Files",
  "authority.subject.rows": "Rows",
  "authority.review.tile.read": "Read",
  "authority.review.tile.write": "Write",
  "authority.review.tile.risky": "Delete or unclear",
  "authority.review.readOnly": "Only reads from {scope} at {service}. Changes nothing.",
  "authority.review.writes": "Writes to {service}.",
  "authority.review.model.only":
    "Sends step data to the workspace AI model. Each call counts against the AI budget.",
  "authority.review.model.also":
    "Also sends step data to the workspace AI model. Each call counts against the AI budget.",
  "authority.review.model.group": "AI model",
  "authority.review.model.budget": "Counts against the AI budget",
  "authority.review.model.tokens": "At most {count} output tokens per call",
  "authority.review.model.tokensPerItem": "At most {count} output tokens per call, once per item",
  "authority.review.model.data": "Sends: {paths}",
  "authority.review.model.noData": "Sends the prompt only, no run data",
  "authority.review.compared": "Compared with {version}:",
  "authority.review.comparedUnapproved": "Compared with {version} (not approved):",
  "authority.review.change.added": "{count} new",
  "authority.review.change.widened": "{count} widened",
  "authority.review.change.unchanged": "{count} unchanged",
  "authority.review.change.removed": "{count} removed",
  "authority.review.row.added": "new",
  "authority.review.row.widened": "widened",
  "authority.review.ceiling": "up to {count} per run",
  "authority.review.ceilingChange": "{previous} → {count} per run",
  "authority.review.details": "Details",
  "authority.review.viaCall": "via step {step}",
  "authority.review.placeholder.enum": "{name}: only {values}",
  "authority.review.placeholder.caller": "{name}: always the signed-in person",
  "authority.review.placeholder.created": "{name}: only an id this workflow created itself, once",
  "authority.review.recordsCreated":
    "Records the id it creates (from {id_path}) under {collection}; later removals may only use ids recorded here.",
  "authority.review.unbound": "Any {names}: the approval does not limit which one.",
  "authority.review.paging": "Pages through {params}.",
  "authority.review.runtimeValues":
    "Values such as a date or a commit are produced at run time. Approved are target, shape and ceiling.",
  "authority.review.problem": "This version cannot be approved yet.",
  "authority.review.replaces": "Replaces {version}",
  "authority.review.startRun": "Start a run afterwards",
  "authority.review.startRunNext": "Otherwise the next run follows the schedule: {time}",
  "authority.review.startRunNone":
    "Otherwise nothing runs until a schedule, a webhook or a person starts it.",
  "authority.review.approve": "Approve",
  "authority.review.approveWrites": "Approve with write access",
  "authority.review.lead": "You decide what this workflow may do. The approval stays with you.",
  "authority.review.activateOnly": "Apply only",
  "authority.review.adopt": "Apply",
  "authority.adopted": "Applied. The existing approval stays valid.",
  "authority.adoptFailed": "The change could not be applied. Review it instead.",
  "authority.review.help.approve": "Activates and allows runs within these limits.",
  "authority.review.help.approveGrant": "Allows runs within these limits.",
  "authority.review.help.activateOnly": "Activates without allowing runs.",
  "authority.review.help.activateOnlyHeld":
    "Switches on without allowing runs; the schedule is on hold.",
  "authority.review.help.adopt": "The existing approval stays valid.",
  "authority.review.help.cancel": "Closes without changes.",
  "authority.content.members.one": "Update 1 fixed content item",
  "authority.content.members.other": "Update {count} fixed content items",
  "authority.content.scope":
    "Only new revisions of these items, up to 1 MB each, may be published to this site. Other items and removals are excluded.",
  "authority.content.targets": "Content and publication destination",
  "authority.outbox.recipients": "Messages from a queue",
  "authority.outbox.delivery":
    "From {from} to the address in {field} of step {source}'s answer; one message per {item}, at most {bytes} request bytes and {perDay} messages a day.",
  "authority.outbox.scope":
    "Authorizes one email per queued message to whichever recipient that queue returns in the same run. Whoever can fill the queue chooses the recipients, so approve only a queue you trust. No CC/BCC and no automatic resend after an uncertain result.",
  "authority.transactional.recipients": "Replies to signed requests",
  "authority.transactional.delivery":
    "From {from} to the address in {field}; event {event} from {eventField}, request ID from {requestField}, at most {bytes} request bytes; signed source {hook}.",
  "authority.transactional.scope":
    "Authorizes one email per unique request to a changing recipient from the signed input. No CC/BCC or automatic resend after an uncertain result. Run and time limits still apply.",
  "authority.report.recipients": "Fixed delivery",
  "authority.report.delivery": "From {from} to {to}",
  "authority.report.variable":
    "Subject and report contents may change. Additional recipients and attachments are not allowed.",
  "authority.report.next": "Next scheduled time: {time} ({zone})",
  "authority.sessionExpired": "Please sign in again",
  "authority.sessionExpiredHint":
    "Your session is no longer valid. Nothing was approved. Sign in, then review and confirm here again.",
  "authority.signIn": "Sign in and return here",
  "authority.unsupportedSteps": "Review these steps: {steps}",
  "authority.adjustDescription":
    "SubKit cannot verify the allowed actions yet; have the cause investigated here in chat.",
  "authority.adjust": "Investigate in this chat",
  "authority.existing.description":
    "Another approval extends the existing one or changes its limits.",
  "authority.scope.environment.title": "This approval only applies to {selected}",
  "authority.scope.environment.description":
    "The workflow is started automatically in {runsIn}. It stays unapproved there.",
  "authority.scope.version.title": "You are approving a draft",
  "authority.scope.version.description":
    "{active} is running. Approving applies the draft in its place.",
  "authority.scope.version.first": "No version is running yet. Approving applies this one.",
  "authority.suggestion.schedule": "Suggested: as many runs as the schedule starts in 30 days.",
  "authority.suggestion.hook.one":
    "Suggested from 1 webhook call in the last {days} days, with headroom.",
  "authority.suggestion.hook.other":
    "Suggested from {count} webhook calls in the last {days} days, with headroom.",
  "authority.suggestion.hookMinimum.one":
    "Suggested minimum for a webhook: only 1 call arrived in the last {days} days.",
  "authority.suggestion.hookMinimum.other":
    "Suggested minimum for a webhook: only {count} calls arrived in the last {days} days.",
  "authority.adjustPrompt":
    "Automatic runs of this workflow cannot be approved yet. Diagnose which steps block the approval and change exactly those steps so an approval can cover them; keep the schedule and destinations unless I ask otherwise. Check the change without live effects and save it as a draft. Do not activate or approve anything: a person approves in the dialog afterwards. If no permitted change exists, say plainly why and what works instead. If a business detail such as a sender or recipient is missing, ask one short question with clear options and a recommendation. Answer briefly, without code or tool names.",
  "authority.incompleteTitle": "Request details are incomplete",
  "authority.incompleteDescription":
    "Check again. If details are still missing, adjust the workflow before granting permission.",
  "authority.runsError": "Enter a whole number from 1 to 10,000.",
  "authority.hoursError": "Enter a whole number from 1 to 744.",
  "authority.versionPrepared": "{version} · draft",
  "authority.versionRunning": "{version} · currently running",
  "authority.noneActive": "no version yet",
  "authority.carryOver.hint":
    "This version reaches nothing the current approval does not already cover. Applying it carries that approval over; nothing new needs approving.",
  "authority.activatedOnly": "Draft applied. Runs are not approved yet.",
  "authority.configuredConnector": "Configured connector",
  "authority.reviewExpired": "Review is no longer current",
  "authority.reviewExpiredHint": "Check again before granting permission.",
  "authority.grantOpen": "Review permission",
  "authority.hours": "Valid for (hours)",
  "authority.requestReview": "Request content: {step}",
  "authority.attempts": "Retry-policy maximum attempts per invocation: {count}",
  "authority.requestTarget": "Target: {method} {url}",
  "authority.requestTargetOpen": "Target: {method}, the address is set when the run starts",
  "authority.iteration": "Iteration {step} can repeat: {children}",
  "authority.maskedDescription":
    "Credentials are hidden. Expand a request to inspect its contents.",
  "authority.grantFailed": "The grant could not be confirmed",
  "authority.grantFailedDescription":
    "The boundary may have changed, your session may lack permission, or the response may have been lost. Check the authority history before preparing another grant; this review is not retried automatically.",
  "authority.prepare": "Check again",
  "authority.granting": "Approving…",
  "authority.connector": "Connector",
  "authority.directRequest": "Direct request without a connector",
  "authority.usedByRun": "Authority recorded for this run",
  "authority.noStoredBinding": "No approval binding recorded",
  "authority.version": "Version",
  "authority.environment": "Environment",
  "authority.production": "Production",
  "authority.development": "Test",
  "authority.decision.reason.schedule": "The schedule starts it there.",
  "authority.decision.reason.scheduleWhen": "The schedule starts it there, {when}.",
  "authority.decision.reason.inbound_hook": "Calls from outside start it there.",
  "authority.decision.reason.existing_approval": "It already has an approval there.",
  "authority.decision.reason.started_manually": "You start it yourself.",
  "authority.decision.choice.dev": "Test: for trying it out. You start it yourself.",
  "authority.decision.choice.prod":
    "Production: works with your real data. Needed when a schedule or a call from outside starts it.",
  "authority.decision.none.title": "Not possible yet",
  "authority.decision.unnamedConnector": "A connector",
  "authority.decision.block.connector_missing": "{connector} does not exist in {environment}.",
  "authority.decision.block.connector_without_sign_in":
    "{connector} has no sign-in in {environment}.",
  "authority.decision.block.connector_needs_sign_in_again":
    "{connector} must be signed in again in {environment}.",
  "authority.decision.block.connector_switched_off":
    "{connector} is switched off in {environment}.",
  "authority.window": "Valid from — until (local time)",
  "authority.requests": "Request contents",
  "authority.growth.newConnector": "New target: {name}",
  "authority.growth.newTarget": "New address: {target}",
  "authority.growth.newDevice": "New device: {name}",
  "authority.growth.newFolder": "New folder: {name}",
  "authority.growth.folderWrites": "Now writes to folder: {name}",
  "authority.growth.newSite": "New website: {name}",
  "authority.growth.privateSite": "New private address: {name}",
  "authority.growth.newApp": "New app: {name}",
  "authority.growth.newSecret": "Newly uses from the vault: {name}",
  "authority.growth.newModelCall": "Newly sends data from step {name} to the AI model",
  "authority.review.vault": "Uses from the vault: {names}",
  "authority.growth.writes": "New: writes to {name}",
  "authority.growth.deletes": "New: deletes at {name}",
  "authority.growth.unknown": "New: an effect at {name} that cannot be classified",
  "authority.growth.changed": "Changed: the connection to {name}",
  "authority.growth.more": "{line} (and {count} more)",
  "authority.runs": "Maximum runs",
  "authority.remaining": "{remaining} of {max} runs left",
  "authority.effects": "Operations and external targets",
  "authority.noEffects": "No connector effects in this manifest.",
  "authority.unboundTarget": "Target not bound",
  "authority.storage.write": "Save report files",
  "authority.storage.read": "Read report files",
  "authority.storage.folder": "Folder: {folder}",
  "authority.storage.writeScope":
    "File names and contents may change. Existing files in this folder may be replaced. Maximum {bytes} bytes per file.",
  "authority.storage.listScope.one": "List 1 file per lookup within this folder.",
  "authority.storage.listScope.other": "List up to {count} files per lookup within this folder.",
  "authority.storage.readScope": "Read files within this folder.",
  "authority.storage.delete": "Permanently delete report files",
  "authority.storage.deleteScope.one":
    "Files inside this folder are deleted for good and cannot be restored. Reviewed ceiling: 1 file per run. Every deletion is checked to stay inside this folder. Deletions are not yet counted against the ceiling.",
  "authority.storage.deleteScope.other":
    "Files inside this folder are deleted for good and cannot be restored. Reviewed ceiling: {count} files per run. Every deletion is checked to stay inside this folder. Deletions are not yet counted against the ceiling.",
  "authority.storage.unknown": "Unrecognised storage action",
  "authority.storage.unknownScope":
    "This dialog cannot describe the action “{operation}”. Do not approve it until the action is understood.",
  "authority.boundary.read": "Read from a fixed address",
  "authority.boundary.send": "Send to a fixed address",
  "authority.boundary.delete": "Delete at a fixed address",
  "authority.boundary.unknown": "Unrecognised request type",
  "authority.boundary.readHosts": "Read from an address on listed hosts",
  "authority.boundary.sendHosts": "Send to an address on listed hosts",
  "authority.boundary.allowedHosts":
    "{name} comes from the run and may be any https address, without port or credentials, on exactly these hosts: {hosts}",
  "authority.boundary.target": "{method} {target}",
  "authority.boundary.variable": "{name} may only be: {values}",
  "authority.boundary.variableEncoded":
    "{name} may only be: {values}. Shown exactly as sent; decoded this reads: {decoded}.",
  "authority.boundary.class.identifier":
    "{name} may be any identifier made of letters, digits, “_” and “-” (up to 200 characters).",
  "authority.boundary.class.long_identifier":
    "{name} may be any long identifier made of letters, digits, “_” and “-” (up to 1,024 characters), such as an attachment ID.",
  "authority.boundary.class.uuid": "{name} may be any UUID.",
  "authority.boundary.callerBound": "{name} is always the signed-in caller's own identity.",
  "authority.boundary.createdByWorkflow":
    "{name} may only be an id an earlier step of this workflow created and recorded; each is removed at most once.",
  "authority.boundary.class.integer":
    "{name} may be any whole number without a sign (up to 19 digits).",
  "authority.boundary.class.date": "{name} may be any date written YYYY-MM-DD.",
  "authority.boundary.class.timestamp":
    "{name} may be any UTC time written like 2026-01-31T23:59:59Z.",
  "authority.boundary.class.timestamp_range":
    "{name} may be any lower time bound written like >=2026-01-31T23:59:59Z.",
  "authority.boundary.class.file_name":
    "{name} may be any single file name — letters, digits, “_” and “-”, then one dot and a short extension. It cannot contain “/”, so it stays in this one folder.",
  "authority.boundary.class.path":
    "{name} may be any page on this one address — this approval does not limit which page. It cannot reach another address, and it cannot leave this address by any spelling.",
  "authority.boundary.paging.one":
    "This read is handed out one page at a time: SubKit sends 1 request to the address, moving only {params}. Nothing else about the request changes.",
  "authority.boundary.paging.other":
    "This read is handed out one page at a time: SubKit sends up to {count} requests to the same address, moving only {params}. Nothing else about the request changes.",
  "authority.boundary.classNotice":
    "A value limited only by its form is chosen at run time. This approval does not limit which records are addressed, only what the value looks like.",
  "authority.boundary.unknownRule":
    "{name} is limited by a rule this dialog cannot describe ({rule}). Do not approve until it is understood.",
  "authority.boundary.bodyLimit": "At most {bytes} bytes of content per request.",
  "authority.boundary.noBody": "Sends no content.",
  "authority.boundary.declaredDestructive":
    "The author marked this request as one that removes or irreversibly changes data.",
  "authority.boundary.calls.one":
    "Reviewed ceiling: 1 request per run. This number is reviewed, but not yet counted by the system.",
  "authority.boundary.calls.other":
    "Reviewed ceiling: {count} requests per run. This number is reviewed, but not yet counted by the system.",
  "authority.boundary.contentNotice":
    "The content is decided at run time. This approval limits where the request goes and how large it is — not what it contains, for example which records it changes or removes.",
  "authority.call.title": "Step {step} starts the workflow „{name}“ (version {version})",
  "authority.call.scope":
    "Everything below is what that workflow does on every start. This approval covers exactly this version; a new version needs a new approval.",
  "authority.issuesTitle": "Why this cannot be approved yet",
  "authority.issueStep": "Step {step}",
  "authority.issueInCall": "Step {step}, inside the workflow started by {call}",
  "authority.issue.missing_binding":
    "This step could not be tied to a connector, so there is no target to approve.",
  "authority.issue.binding_mismatch":
    "What this step declares and what it resolves to no longer agree.",
  "authority.issue.environment_mismatch": "This step uses a connector that does not exist here.",
  "authority.issue.dynamic_request":
    "Where this request goes is decided at run time and is not limited to anything reviewable.",
  "authority.issue.unknown_effect":
    "What this step does to the other system cannot be determined in advance.",
  "authority.issue.destructive_effect": "This step removes data, and nothing limits how much.",
  "authority.issue.unbound_workflow_call":
    "This step starts another workflow that this approval could not be extended to cover.",
  "authority.issue.boundary_contradicted_by_history":
    "The folder this step declares does not contain what the step actually writes.",
  "authority.issueEvidence": "Declared: {declared} · last written: {observed}",
  "authority.issueUnavailable": "Step {step} could not be prepared at all.",
  "authority.readPath":
    "Read records in this collection. Record IDs may change; the server and collection stay fixed.",
  "authority.digest": "Effect manifest digest",
  "authority.revokeFailed": "The authority could not be revoked.",
  "authority.loadFailed": "The authority history could not be loaded.",
  "authority.prepareFailed": "The approval could not be loaded. Nothing was changed.",
  "authority.more": "Load older authorities",
  "authority.state.approved": "Approved",
  "authority.state.notYetValid": "Not yet valid",
  "authority.state.expired": "Expired",
  "authority.state.revoked": "Revoked",
  "authority.state.superseded": "Carried over to a newer version",
  "authority.headline.untilRevoked": "until revoked",
  "authority.headline.runs.unlimited": "unlimited runs",
  "authority.runsUnlimited": "Unlimited · {count} so far",
  "authority.suggestion.hookNone":
    "No webhook call arrived in the last {days} days, so the suggestion is a small starting value.",
  "authority.limit.label": "Validity",
  "authority.limit.untilRevoked": "Until revoked",
  "authority.limit.limited": "Limit",
  "authority.limit.limitedHint":
    "Ends after the runs or the hours below, whichever comes first. You can revoke it at any time.",
  "authority.state.exhausted": "Run limit reached",
  "authority.state.invalidated": "Boundary changed",
  "authority.state.unavailable": "Unavailable",
  "authority.effect.read": "Read",
  "authority.effect.write": "Write",
  "authority.effect.destructive": "Destructive",
  "authority.effect.unknown": "Unknown effect",
  "permission.resource.rbac": "Roles and access",
  "permission.label": "{resource} · {action}",
  "permission.action.abort": "Abort",
  "permission.action.activate": "Activate",
  "permission.action.admin": "Administer",
  "permission.action.approve": "Approve",
  "permission.action.archive": "Archive",
  "permission.action.authoring": "Author",
  "permission.action.cancel": "Cancel",
  "permission.action.delete": "Delete",
  "permission.action.list": "List",
  "permission.action.oauth": "Connect OAuth",
  "permission.action.promote": "Promote",
  "permission.action.read": "View",
  "permission.action.confirm": "Confirm",
  "permission.action.confirmLocalCommand": "Allow local commands",
  "permission.action.revoke": "Revoke",
  "permission.action.revokeAny": "Revoke for anyone",
  "permission.action.manage": "Manage",
  "permission.action.disable": "Disable",
  "permission.action.restart": "Restart",
  "permission.action.rotate": "Rotate",
  "permission.action.reveal": "Reveal",
  "permission.action.run": "Start",
  "permission.action.signal": "Send signal",
  "permission.action.test": "Test",
  "permission.action.write": "Edit",
  "permission.resource.chatIdentity": "Chat identities",
  "permission.resource.chatWorkspace": "Chat workspaces",
  "permission.resource.credentials": "Credentials",
  "permission.resource.vault": "Vault",
  "permission.resource.discovery": "Discovery",
  "permission.resource.engine": "Engine",
  "permission.resource.inboundHooks": "Inbound hooks",
  "permission.resource.intake": "Collected items",
  "permission.resource.mcp": "MCP",
  "permission.resource.mcpClients": "MCP clients",
  "permission.resource.metrics": "Metrics",
  "permission.resource.packages": "Packages",
  "permission.resource.portalTokens": "Portal tokens",
  "authority.refusal.no_boundary":
    "This step has no reviewed limit yet, so nothing says where it may go or how large it may be.",
  "authority.refusal.stricter_profile_applies":
    "This step is a report e-mail or a content publication. Those have their own, stricter review of the recipient or the published items — a general limit does not belong here.",
  "authority.trial.title": "Trial run in progress",
  "authority.trial.what":
    "This trial run reads from your connected systems for real and holds back every write, so nothing is changed there.",
  "authority.trial.elapsed": "Running for {seconds} seconds.",
  "authority.trial.alreadyRunning":
    "A trial run for this workflow is already in progress — most likely in another tab. This one is waiting for it rather than starting a second.",
  "authority.sample.title": "A sample call from “{slug}” is needed",
  "authority.sample.what":
    "The webhook “{slug}” starts this workflow, and its refused calls are not kept. The trial run needs one call as it would arrive — nothing is sent. The field holds the newest call this workflow received, or an empty template: put in what the sender really delivers.",
  "authority.sample.label": "Sample call (JSON)",
  "authority.sample.invalid": "This is not valid JSON.",
  "authority.sample.schema": "The sample does not match the workflow's expected input: {detail}",
  "authority.sample.prepare": "Start trial run with this call",
  "authority.refusal.report_delivery_unprepared":
    "This step sends a report by e-mail, and nothing has watched it do so yet. A trial run — which holds back everything it would send — shows who would receive it, and that is what gets approved.",
  "authority.refusal.report_delivery_unobserved":
    "A trial run reached this step but did not record a recipient, so there is nothing to approve yet. Open that run and look at this step: the address was probably never worked out.",
  "authority.refusal.report_delivery_unreachable":
    "A trial run never got as far as this step, so nobody has seen who would receive the e-mail. Another trial run will not help, because the step is only reached after something has been sent. Name the recipient on the step instead. What is sent is still checked against that name every time.",
  "authority.refusal.target_unresolved":
    "The target cannot be worked out: the connector has no base address and the path is not an absolute one.",
  "authority.refusal.path_unsupported":
    "The address is put together in a way a limit cannot describe segment by segment.",
  "authority.refusal.partial_segment_placeholder":
    "A placeholder covers only part of an address segment. A limit can name a whole segment, not a piece of one.",
  "authority.refusal.runtime_header":
    "A header is filled at runtime in a form a limit cannot describe.",
  "authority.refusal.header_boundary_mismatch":
    "The limit names different headers than the step actually fills at runtime.",
  "authority.refusal.runtime_value_outside_path_and_body":
    "A runtime value appears somewhere other than the address or the body — there is nothing to bound it with.",
  "authority.refusal.query_placeholder_unsupported":
    "A query parameter is filled at runtime in a form a limit cannot describe.",
  "authority.refusal.pagination_unbounded":
    "This step pages through results without a cap, so the number of requests is open.",
  "authority.refusal.pagination_param_conflict":
    "The paging parameters contradict the limit that is meant to cover them.",
  "authority.refusal.delete_requires_destructive":
    "This step removes data. A limit only covers that if it says so explicitly.",
  "authority.refusal.delete_requires_enum":
    "A removal must name exactly what it may remove, not a pattern.",
  "authority.refusal.created_by_workflow_misplaced":
    "Only a removal through a connector may limit a path segment to ids this workflow created.",
  "authority.refusal.variable_in_base_prefix":
    "A placeholder sits in the fixed part of the address, so the target itself could move.",
  "authority.refusal.enum_value_unroutable":
    "One of the permitted values does not lead anywhere this connector can reach.",
  "authority.refusal.boundary_invalid": "The limit on this step cannot be read as written.",
  "authority.refusal.variables_mismatch":
    "The limit names different placeholders than the step actually uses.",
  "authority.refusal.not_http_step": "This kind of step cannot carry a limit yet.",
  "authority.refusal.no_scope":
    "This storage step has no reviewed folder, so nothing says which files it may access.",
  "authority.refusal.scope_invalid": "The folder on this step cannot be read as written.",
  "authority.refusal.unsupported_method":
    "This storage operation cannot be reviewed for repeated runs yet.",
  "authority.refusal.delete_with_body":
    "A removal that also sends content cannot be reviewed as a removal.",
  "authority.refusal.runtime_value_outside_key":
    "A runtime value appears somewhere other than the file name, so the folder cannot cover it.",
  "authority.refusal.query_or_headers_present":
    "This storage step sends query parameters or headers, which a folder does not describe.",
  "authority.refusal.unsupported_option":
    "This step uses a storage option the reviewed form does not cover.",
  "authority.refusal.content_type_invalid": "The declared content type cannot be read as written.",
  "authority.refusal.base_unresolved":
    "The storage address cannot be worked out from this connector.",
  "authority.grantSaved": "Permission saved. The decision status has been refreshed.",
  "authority.headline.runs.one": "up to {max} run",
  "authority.headline.runs.other": "up to {max} runs",
  "authority.headline.until": "valid until {until}",
  "permission.labelAll": "{resource} · {action} (all people)",
  "permission.actionAll": "{action} (all people)",
  "permission.labelGlobal": "{resource} · {action} (whole engine)",
  "permission.actionGlobal": "{action} (whole engine)",
  "permission.resource.apiKeys": "API keys",
  "permission.resource.mcpExternalTools": "External MCP tools",
  "permission.resource.memory": "Conversation memory",
  "permission.resource.connections": "Account connections",
  "permission.resource.schedules": "Schedules",
  "permission.resource.tasks": "Tasks",
  "permission.resource.devices": "Devices",
  "permission.resource.localSteps": "Steps on a device",
  "permission.resource.taskRuns": "Task runs",
  "permission.action.grant": "Give the standing permission",
  "permission.resource.subscriptions": "Subscriptions",
  "permission.action.commit": "Commit",
  "permission.action.export": "Export",
  "permission.action.import": "Import",
  "permission.action.invoke": "Invoke",
  "permission.action.pause": "Pause",
  "permission.action.propose": "Propose",
  "permission.action.replay": "Replay",
  "permission.action.restore": "Restore",
  "permission.action.resume": "Resume",
  "authority.refusal.report_delivery_contradicted":
    "The e-mail this trial run would have sent does not match the step. The message is outside the report format, or it goes to a different address. Every run would be refused at sending. Change the step or its declaration so the two agree.",
  "authority.inactiveVersion": "For a version that is not running.",
} as const;

export const authorityDe: Record<keyof typeof authorityEn, string> = {
  "authority.namedTitle": "{name} {version} freigeben",
  "authority.subject.issues": "Issues",
  "authority.subject.comments": "Kommentare",
  "authority.subject.commits": "Commits",
  "authority.subject.pulls": "Pull Requests",
  "authority.subject.repos": "Repositories",
  "authority.subject.ref": "Stand eines Branches",
  "authority.subject.contents": "Dateien im Repository",
  "authority.subject.messages": "Nachrichten",
  "authority.subject.files": "Dateien",
  "authority.subject.rows": "Zeilen",
  "authority.review.tile.read": "Lesen",
  "authority.review.tile.write": "Schreiben",
  "authority.review.tile.risky": "Löschen oder unklar",
  "authority.review.readOnly": "Liest nur aus {scope} bei {service}. Ändert nichts.",
  "authority.review.writes": "Schreibt an {service}.",
  "authority.review.model.only":
    "Schickt Daten aus Schritten an das KI-Modell deines Workspaces. Jeder Aufruf zählt gegen dein KI-Budget.",
  "authority.review.model.also":
    "Schickt außerdem Daten aus Schritten an das KI-Modell deines Workspaces. Jeder Aufruf zählt gegen dein KI-Budget.",
  "authority.review.model.group": "KI-Modell",
  "authority.review.model.budget": "Zählt gegen dein KI-Budget",
  "authority.review.model.tokens": "Höchstens {count} Ausgabe-Tokens pro Aufruf",
  "authority.review.model.tokensPerItem":
    "Höchstens {count} Ausgabe-Tokens pro Aufruf, einmal pro Eintrag",
  "authority.review.model.data": "Schickt: {paths}",
  "authority.review.model.noData": "Schickt nur den Prompt, keine Run-Daten",
  "authority.review.compared": "Gegenüber {version}:",
  "authority.review.comparedUnapproved": "Gegenüber {version} (nicht freigegeben):",
  "authority.review.change.added": "{count} neu",
  "authority.review.change.widened": "{count} erweitert",
  "authority.review.change.unchanged": "{count} unverändert",
  "authority.review.change.removed": "{count} entfernt",
  "authority.review.row.added": "neu",
  "authority.review.row.widened": "erweitert",
  "authority.review.ceiling": "bis {count} / Run",
  "authority.review.ceilingChange": "{previous} → {count} / Run",
  "authority.review.details": "Details",
  "authority.review.viaCall": "über Schritt {step}",
  "authority.review.placeholder.enum": "{name}: nur {values}",
  "authority.review.placeholder.caller": "{name}: immer die angemeldete Person",
  "authority.review.placeholder.created":
    "{name}: nur eine ID, die dieser Workflow selbst angelegt hat, einmal",
  "authority.review.recordsCreated":
    "Vermerkt die angelegte ID (aus {id_path}) unter {collection}; spätere Entfernungen dürfen nur hier vermerkte IDs verwenden.",
  "authority.review.unbound": "Beliebige {names}: welche, begrenzt die Freigabe nicht.",
  "authority.review.paging": "Blättert über {params}.",
  "authority.review.runtimeValues":
    "Werte wie Datum oder Commit entstehen zur Laufzeit. Freigegeben sind Ziel, Form und Obergrenze.",
  "authority.review.problem": "Diese Version lässt sich noch nicht freigeben.",
  "authority.review.replaces": "Ersetzt {version}",
  "authority.review.startRun": "Danach einen Run starten",
  "authority.review.startRunNext": "Sonst nächster Run laut Zeitplan: {time}",
  "authority.review.startRunNone":
    "Sonst läuft nichts, bis ein Zeitplan, ein Webhook oder eine Person ihn startet.",
  "authority.review.approve": "Freigeben",
  "authority.review.approveWrites": "Mit Schreibzugriff freigeben",
  "authority.review.lead": "Du legst fest, was dieser Workflow darf. Die Freigabe bleibt bei dir.",
  "authority.review.activateOnly": "Nur übernehmen",
  "authority.review.adopt": "Übernehmen",
  "authority.adopted": "Übernommen. Die bestehende Freigabe gilt weiter.",
  "authority.adoptFailed": "Die Änderung konnte nicht übernommen werden. Bitte prüfen.",
  "authority.review.help.approve": "Aktiviert und erlaubt Runs in diesen Grenzen.",
  "authority.review.help.approveGrant": "Erlaubt Runs in diesen Grenzen.",
  "authority.review.help.activateOnly": "Aktiviert ohne Runs.",
  "authority.review.help.activateOnlyHeld":
    "Schaltet ein, ohne Runs zu erlauben; der Zeitplan ist angehalten.",
  "authority.review.help.adopt": "Bestehende Freigabe gilt weiter.",
  "authority.review.help.cancel": "Schließt ohne Änderung.",
  "authority.content.members.one": "1 festgelegten Inhalt aktualisieren",
  "authority.content.members.other": "{count} festgelegte Inhalte aktualisieren",
  "authority.content.scope":
    "Nur neue Versionen dieser Inhalte mit jeweils höchstens 1 MB dürfen auf dieser Website veröffentlicht werden. Weitere Inhalte und Löschungen sind ausgeschlossen.",
  "authority.content.targets": "Betroffene Inhalte und Veröffentlichungsziel",
  "authority.outbox.recipients": "Nachrichten aus einer Warteschlange",
  "authority.outbox.delivery":
    "Von {from} an die Adresse aus {field} in der Antwort von Schritt {source}; eine Nachricht je {item}, höchstens {bytes} Anfrage-Bytes und {perDay} Nachrichten pro Tag.",
  "authority.outbox.scope":
    "Erlaubt eine E-Mail je Eintrag der Warteschlange an den Empfänger, den diese Warteschlange im selben Run liefert. Wer die Warteschlange füllen kann, bestimmt die Empfänger – gib nur eine Warteschlange frei, der du vertraust. Kein CC/BCC und kein automatischer Neuversand bei unklarem Ergebnis.",
  "authority.transactional.recipients": "Antworten auf signierte Anfragen",
  "authority.transactional.delivery":
    "Von {from} an die Adresse aus {field}; Ereignis {event} aus {eventField}, Anfrage-ID aus {requestField}, höchstens {bytes} Anfrage-Bytes; signierte Quelle {hook}.",
  "authority.transactional.scope":
    "Erlaubt eine E-Mail je eindeutiger Anfrage an wechselnde Empfänger aus der signierten Eingabe. Kein CC/BCC und kein automatischer Neuversand bei unklarem Ergebnis. Run- und Zeitgrenzen gelten weiterhin.",
  "authority.report.recipients": "Fester Versand",
  "authority.report.delivery": "Von {from} an {to}",
  "authority.report.variable":
    "Betreff und Berichtsinhalt dürfen sich ändern. Zusätzliche Empfänger und Anhänge sind nicht erlaubt.",
  "authority.report.next": "Nächster geplanter Termin: {time} ({zone})",
  "authority.sessionExpired": "Bitte neu anmelden",
  "authority.sessionExpiredHint":
    "Deine Sitzung ist nicht mehr gültig. Es wurde nichts freigegeben. Melde dich an und bestätige anschließend hier erneut.",
  "authority.signIn": "Anmelden und hier fortfahren",
  "authority.unsupportedSteps": "Diese Schritte prüfen: {steps}",
  "authority.adjustDescription":
    "SubKit kann die erlaubten Aktionen noch nicht prüfen; lass die Ursache hier im Chat untersuchen.",
  "authority.adjust": "Ursache im Chat prüfen",
  "authority.existing.description":
    "Eine weitere Freigabe verlängert die bestehende oder ändert ihre Grenzen.",
  "authority.scope.environment.title": "Diese Freigabe gilt nur für {selected}",
  "authority.scope.environment.description":
    "Automatisch gestartet wird der Workflow in {runsIn}. Dort bleibt er ohne Freigabe.",
  "authority.scope.version.title": "Du gibst einen Entwurf frei",
  "authority.scope.version.description":
    "Es läuft {active}. Mit der Freigabe wird der Entwurf an seiner Stelle übernommen.",
  "authority.scope.version.first":
    "Noch läuft keine Version. Mit der Freigabe wird diese übernommen.",
  "authority.suggestion.schedule":
    "Vorschlag: so viele Runs, wie der Zeitplan in 30 Tagen startet.",
  "authority.suggestion.hook.one":
    "Vorschlag aus 1 Webhook-Aufruf der letzten {days} Tage, mit Reserve.",
  "authority.suggestion.hook.other":
    "Vorschlag aus {count} Webhook-Aufrufen der letzten {days} Tage, mit Reserve.",
  "authority.suggestion.hookMinimum.one":
    "Vorschlag: Mindestwert für Webhooks – in den letzten {days} Tagen kam nur 1 Aufruf.",
  "authority.suggestion.hookMinimum.other":
    "Vorschlag: Mindestwert für Webhooks – in den letzten {days} Tagen kamen nur {count} Aufrufe.",
  "authority.adjustPrompt":
    "Automatische Runs dieses Ablaufs lassen sich noch nicht freigeben. Ermittle, welche Schritte die Freigabe blockieren, und baue genau diese Schritte so um, dass eine Freigabe sie abdecken kann; Zeitplan und Ziele bleiben, außer ich wünsche es anders. Prüfe die Änderung ohne Live-Wirkungen und speichere sie als Entwurf. Aktiviere nichts und gib nichts frei: Die Freigabe erteilt danach ein Mensch im Dialog. Ist kein zulässiger Umbau möglich, sage klar warum und was stattdessen geht. Fehlt eine fachliche Angabe wie Absender oder Empfänger, stelle eine kurze Frage mit klaren Auswahlmöglichkeiten und einer Empfehlung. Antworte knapp, ohne Code oder Tool-Namen.",
  "authority.incompleteTitle": "Anfragedetails fehlen",
  "authority.incompleteDescription":
    "Erneut prüfen. Fehlen weiterhin Details, den Workflow vor der Freigabe anpassen.",
  "authority.runsError": "Eine ganze Zahl von 1 bis 10.000 eingeben.",
  "authority.hoursError": "Eine ganze Zahl von 1 bis 744 eingeben.",
  "authority.versionPrepared": "{version} · Entwurf",
  "authority.versionRunning": "{version} · läuft derzeit",
  "authority.noneActive": "noch keine Version",
  "authority.carryOver.hint":
    "Diese Version erreicht nichts, was die bestehende Freigabe nicht schon abdeckt. Beim Übernehmen gilt die Freigabe weiter; neu freizugeben ist nichts.",
  "authority.activatedOnly": "Entwurf übernommen. Runs sind noch nicht freigegeben.",
  "authority.configuredConnector": "Konfigurierter Connector",
  "authority.reviewExpired": "Prüfung nicht mehr aktuell",
  "authority.reviewExpiredHint": "Vor der Freigabe erneut prüfen.",
  "authority.grantOpen": "Freigabe prüfen",
  "authority.hours": "Gültig für (Stunden)",
  "authority.requestReview": "Anfrageinhalt: {step}",
  "authority.attempts": "Maximale Versuche laut Retry-Regel je Aufruf: {count}",
  "authority.requestTarget": "Ziel: {method} {url}",
  "authority.requestTargetOpen": "Ziel: {method}, die Adresse steht erst beim Start des Runs fest",
  "authority.iteration": "Iteration {step} kann wiederholen: {children}",
  "authority.maskedDescription":
    "Zugangsdaten sind verborgen. Anfrage aufklappen, um ihren Inhalt zu prüfen.",
  "authority.grantFailed": "Die Freigabe konnte nicht bestätigt werden",
  "authority.grantFailedDescription":
    "Die Grenzen könnten sich geändert haben, deiner Sitzung könnte die Berechtigung fehlen oder die Antwort könnte verloren gegangen sein. Prüfe den Freigabeverlauf vor einer neuen Freigabe; diese Anfrage wird nicht automatisch wiederholt.",
  "authority.prepare": "Erneut prüfen",
  "authority.granting": "Wird freigegeben…",
  "authority.connector": "Connector",
  "authority.directRequest": "Direkte Anfrage ohne Connector",
  "authority.usedByRun": "Für diesen Run gespeicherte Freigabe",
  "authority.noStoredBinding": "Keine Bindung an eine Freigabe gespeichert",
  "authority.version": "Version",
  "authority.environment": "Umgebung",
  "authority.production": "Echtbetrieb",
  "authority.development": "Test",
  "authority.decision.reason.schedule": "Der Zeitplan startet ihn dort.",
  "authority.decision.reason.scheduleWhen": "Der Zeitplan startet ihn dort, {when}.",
  "authority.decision.reason.inbound_hook": "Aufrufe von außen starten ihn dort.",
  "authority.decision.reason.existing_approval": "Dort gibt es schon eine Freigabe.",
  "authority.decision.reason.started_manually": "Du startest ihn selbst.",
  "authority.decision.choice.dev": "Test: zum Ausprobieren. Du startest ihn selbst.",
  "authority.decision.choice.prod":
    "Echtbetrieb: arbeitet mit deinen echten Daten. Nötig, wenn ein Zeitplan oder ein Aufruf von außen ihn startet.",
  "authority.decision.none.title": "Noch nicht möglich",
  "authority.decision.unnamedConnector": "Ein Connector",
  "authority.decision.block.connector_missing": "{connector} gibt es im {environment} nicht.",
  "authority.decision.block.connector_without_sign_in":
    "{connector} hat im {environment} keine Anmeldung.",
  "authority.decision.block.connector_needs_sign_in_again":
    "{connector} muss im {environment} neu angemeldet werden.",
  "authority.decision.block.connector_switched_off":
    "{connector} ist im {environment} ausgeschaltet.",
  "authority.window": "Gültig von — bis (Ortszeit)",
  "authority.requests": "Anfrageinhalte",
  "authority.growth.newConnector": "Neues Ziel: {name}",
  "authority.growth.newTarget": "Neue Adresse: {target}",
  "authority.growth.newDevice": "Neues Gerät: {name}",
  "authority.growth.newFolder": "Neuer Ordner: {name}",
  "authority.growth.folderWrites": "Schreibt jetzt in Ordner: {name}",
  "authority.growth.newSite": "Neue Website: {name}",
  "authority.growth.privateSite": "Neue private Adresse: {name}",
  "authority.growth.newApp": "Neue App: {name}",
  "authority.growth.newSecret": "Nutzt neu aus dem Tresor: {name}",
  "authority.growth.newModelCall": "Schickt neu Daten aus Schritt {name} an das KI-Modell",
  "authority.review.vault": "Nutzt aus dem Tresor: {names}",
  "authority.growth.writes": "Neu: schreibt an {name}",
  "authority.growth.deletes": "Neu: löscht bei {name}",
  "authority.growth.unknown": "Neu: eine nicht einstufbare Wirkung bei {name}",
  "authority.growth.changed": "Geändert: die Verbindung zu {name}",
  "authority.growth.more": "{line} (und {count} weitere)",
  "authority.runs": "Maximale Runs",
  "authority.remaining": "Noch {remaining} von {max} Runs",
  "authority.effects": "Operationen und externe Ziele",
  "authority.noEffects": "Keine Connector-Wirkungen in diesem Manifest.",
  "authority.unboundTarget": "Ziel nicht gebunden",
  "authority.storage.write": "Berichtsdateien speichern",
  "authority.storage.read": "Berichtsdateien lesen",
  "authority.storage.folder": "Ordner: {folder}",
  "authority.storage.writeScope":
    "Dateinamen und Inhalte dürfen wechseln. Vorhandene Dateien in diesem Ordner können ersetzt werden. Höchstens {bytes} Bytes je Datei.",
  "authority.storage.listScope.one": "1 Datei pro Listenabruf innerhalb dieses Ordners.",
  "authority.storage.listScope.other":
    "Bis zu {count} Dateien pro Listenabruf innerhalb dieses Ordners.",
  "authority.storage.readScope": "Dateien innerhalb dieses Ordners lesen.",
  "authority.storage.delete": "Berichtsdateien endgültig löschen",
  "authority.storage.deleteScope.one":
    "Dateien in diesem Ordner werden endgültig gelöscht und lassen sich nicht wiederherstellen. Geprüfte Obergrenze: 1 Datei pro Run. Jede Löschung wird darauf geprüft, in diesem Ordner zu bleiben; die Anzahl pro Run ist eine geprüfte Obergrenze und wird vom System noch nicht mitgezählt.",
  "authority.storage.deleteScope.other":
    "Dateien in diesem Ordner werden endgültig gelöscht und lassen sich nicht wiederherstellen. Geprüfte Obergrenze: {count} Dateien pro Run. Jede Löschung wird darauf geprüft, in diesem Ordner zu bleiben; die Anzahl pro Run ist eine geprüfte Obergrenze und wird vom System noch nicht mitgezählt.",
  "authority.storage.unknown": "Unbekannte Speicher-Aktion",
  "authority.storage.unknownScope":
    "Dieser Dialog kann die Aktion „{operation}“ nicht beschreiben. Bitte nicht freigeben, solange die Aktion nicht geklärt ist.",
  "authority.boundary.read": "Von einer festen Adresse lesen",
  "authority.boundary.send": "An eine feste Adresse senden",
  "authority.boundary.delete": "An einer festen Adresse löschen",
  "authority.boundary.unknown": "Unbekannte Anfrageart",
  "authority.boundary.readHosts": "Von einer Adresse auf erlaubten Hosts lesen",
  "authority.boundary.sendHosts": "An eine Adresse auf erlaubten Hosts senden",
  "authority.boundary.allowedHosts":
    "{name} kommt aus dem Run und darf jede https-Adresse ohne Port und Zugangsdaten auf genau diesen Hosts sein: {hosts}",
  "authority.boundary.target": "{method} {target}",
  "authority.boundary.variable": "{name} darf nur sein: {values}",
  "authority.boundary.variableEncoded":
    "{name} darf nur sein: {values}. Genau so wird es gesendet; entschlüsselt heißt das: {decoded}.",
  "authority.boundary.class.identifier":
    "{name} darf jede Kennung aus Buchstaben, Ziffern, „_“ und „-“ sein (bis 200 Zeichen).",
  "authority.boundary.class.long_identifier":
    "{name} darf jede lange Kennung aus Buchstaben, Ziffern, „_“ und „-“ sein (bis 1.024 Zeichen), etwa eine Anhang-ID.",
  "authority.boundary.class.uuid": "{name} darf jede UUID sein.",
  "authority.boundary.callerBound":
    "{name} ist immer die eigene Identität der angemeldeten Person.",
  "authority.boundary.createdByWorkflow":
    "{name} darf nur eine ID sein, die ein früherer Schritt dieses Workflows angelegt und vermerkt hat; jede wird höchstens einmal entfernt.",
  "authority.boundary.class.integer":
    "{name} darf jede ganze Zahl ohne Vorzeichen sein (bis 19 Stellen).",
  "authority.boundary.class.date": "{name} darf jedes Datum in der Form JJJJ-MM-TT sein.",
  "authority.boundary.class.timestamp":
    "{name} darf jeder UTC-Zeitpunkt in der Form 2026-01-31T23:59:59Z sein.",
  "authority.boundary.class.timestamp_range":
    "{name} darf jede untere Zeitgrenze in der Form >=2026-01-31T23:59:59Z sein.",
  "authority.boundary.class.file_name":
    "{name} darf jeder einzelne Dateiname sein — Buchstaben, Ziffern, „_“ und „-“, dann ein Punkt und eine kurze Endung. Ein „/“ ist nicht möglich, der Wert bleibt also in diesem einen Ordner.",
  "authority.boundary.class.path":
    "{name} darf jede Seite unter dieser einen Adresse sein — welche Seite, begrenzt diese Freigabe nicht. Eine andere Adresse ist nicht erreichbar, und diese Adresse lässt sich auf keine Schreibweise verlassen.",
  "authority.boundary.paging.one":
    "Dieser Lesezugriff kommt seitenweise: SubKit sendet 1 Anfrage an die Adresse und bewegt dabei nur {params}. Sonst ändert sich an der Anfrage nichts.",
  "authority.boundary.paging.other":
    "Dieser Lesezugriff kommt seitenweise: SubKit sendet bis zu {count} Anfragen an dieselbe Adresse und bewegt dabei nur {params}. Sonst ändert sich an der Anfrage nichts.",
  "authority.boundary.classNotice":
    "Ein nur der Form nach begrenzter Wert entsteht erst zur Laufzeit. Diese Freigabe begrenzt nicht, welche Einträge angesprochen werden, sondern nur, wie der Wert aussieht.",
  "authority.boundary.unknownRule":
    "{name} ist durch eine Regel begrenzt, die dieser Dialog nicht beschreiben kann ({rule}). Bitte nicht freigeben, solange das nicht geklärt ist.",
  "authority.boundary.bodyLimit": "Höchstens {bytes} Bytes Inhalt je Anfrage.",
  "authority.boundary.noBody": "Sendet keinen Inhalt.",
  "authority.boundary.declaredDestructive":
    "Der Autor hat diese Anfrage als eine markiert, die Daten entfernt oder unwiderruflich ändert.",
  "authority.boundary.calls.one":
    "Geprüfte Obergrenze: 1 Anfrage pro Run. Diese Zahl ist geprüft, wird vom System aber noch nicht mitgezählt.",
  "authority.boundary.calls.other":
    "Geprüfte Obergrenze: {count} Anfragen pro Run. Diese Zahl ist geprüft, wird vom System aber noch nicht mitgezählt.",
  "authority.boundary.contentNotice":
    "Der Inhalt entsteht erst zur Laufzeit. Diese Freigabe begrenzt, wohin die Anfrage geht und wie groß sie ist — nicht, was sie enthält, zum Beispiel welche Einträge sie ändert oder entfernt.",
  "authority.call.title": "Schritt {step} startet den Workflow „{name}“ (Version {version})",
  "authority.call.scope":
    "Alles Folgende führt dieser Workflow bei jedem Start aus. Die Freigabe gilt genau für diese Version; eine neue Version braucht eine neue Freigabe.",
  "authority.issuesTitle": "Warum das noch nicht freigegeben werden kann",
  "authority.issueStep": "Schritt {step}",
  "authority.issueInCall": "Schritt {step}, im Workflow, den {call} startet",
  "authority.issue.missing_binding":
    "Dieser Schritt ließ sich keinem Connector zuordnen, es gibt also kein Ziel zum Freigeben.",
  "authority.issue.binding_mismatch":
    "Was dieser Schritt deklariert und wozu er sich auflöst, stimmt nicht mehr überein.",
  "authority.issue.environment_mismatch":
    "Dieser Schritt nutzt einen Connector, den es hier nicht gibt.",
  "authority.issue.dynamic_request":
    "Wohin diese Anfrage geht, entscheidet sich zur Laufzeit und ist durch nichts Prüfbares begrenzt.",
  "authority.issue.unknown_effect":
    "Was dieser Schritt im anderen System bewirkt, lässt sich vorab nicht bestimmen.",
  "authority.issue.destructive_effect":
    "Dieser Schritt entfernt Daten, und nichts begrenzt wie viele.",
  "authority.issue.unbound_workflow_call":
    "Dieser Schritt startet einen weiteren Workflow, auf den sich die Freigabe nicht ausdehnen ließ.",
  "authority.issue.boundary_contradicted_by_history":
    "Der Ordner, den dieser Schritt deklariert, enthält nicht, was der Schritt tatsächlich schreibt.",
  "authority.issueEvidence": "Deklariert: {declared} · zuletzt geschrieben: {observed}",
  "authority.issueUnavailable": "Schritt {step} ließ sich gar nicht vorbereiten.",
  "authority.readPath":
    "Einträge dieser Sammlung lesen. Die IDs dürfen wechseln; Server und Sammlung bleiben fest.",
  "authority.digest": "Prüfsumme des Wirkungsmanifests",
  "authority.revokeFailed": "Die Freigabe konnte nicht widerrufen werden.",
  "authority.loadFailed": "Der Freigabeverlauf konnte nicht geladen werden.",
  "authority.prepareFailed": "Die Freigabe konnte nicht geladen werden. Nichts wurde geändert.",
  "authority.more": "Ältere Freigaben laden",
  "authority.state.approved": "Freigegeben",
  "authority.state.notYetValid": "Noch nicht gültig",
  "authority.state.expired": "Abgelaufen",
  "authority.state.revoked": "Widerrufen",
  "authority.state.superseded": "Von neuer Version übernommen",
  "authority.headline.untilRevoked": "bis auf Widerruf",
  "authority.headline.runs.unlimited": "unbegrenzte Runs",
  "authority.runsUnlimited": "Unbegrenzt · bisher {count}",
  "authority.suggestion.hookNone":
    "In den letzten {days} Tagen kam kein Webhook-Aufruf; der Vorschlag ist deshalb ein kleiner Startwert.",
  "authority.limit.label": "Gültigkeit",
  "authority.limit.untilRevoked": "Bis auf Widerruf",
  "authority.limit.limited": "Begrenzen",
  "authority.limit.limitedHint":
    "Endet nach den Runs oder Stunden unten – je nachdem, was zuerst eintritt. Jederzeit widerrufbar.",
  "authority.state.exhausted": "Run-Limit erreicht",
  "authority.state.invalidated": "Grenzen geändert",
  "authority.state.unavailable": "Nicht verfügbar",
  "authority.effect.read": "Lesen",
  "authority.effect.write": "Schreiben",
  "authority.effect.destructive": "Destruktiv",
  "authority.effect.unknown": "Unbekannte Wirkung",
  "permission.resource.rbac": "Rollen und Zugriffe",
  "permission.label": "{resource} · {action}",
  "permission.action.abort": "Abbrechen",
  "permission.action.activate": "Aktivieren",
  "permission.action.admin": "Administrieren",
  "permission.action.approve": "Freigeben",
  "permission.action.archive": "Archivieren",
  "permission.action.authoring": "Erstellen",
  "permission.action.cancel": "Abbrechen",
  "permission.action.delete": "Löschen",
  "permission.action.list": "Auflisten",
  "permission.action.oauth": "OAuth verbinden",
  "permission.action.promote": "Übernehmen",
  "permission.action.read": "Anzeigen",
  "permission.action.confirm": "Bestätigen",
  "permission.action.confirmLocalCommand": "Lokale Befehle erlauben",
  "permission.action.revoke": "Widerrufen",
  "permission.action.revokeAny": "Für alle widerrufen",
  "permission.action.manage": "Verwalten",
  "permission.action.disable": "Deaktivieren",
  "permission.action.restart": "Neu starten",
  "permission.action.rotate": "Rotieren",
  "permission.action.reveal": "Aufdecken",
  "permission.action.run": "Starten",
  "permission.action.signal": "Signal senden",
  "permission.action.test": "Testen",
  "permission.action.write": "Bearbeiten",
  "permission.resource.chatIdentity": "Chat-Identitäten",
  "permission.resource.chatWorkspace": "Chat-Arbeitsbereiche",
  "permission.resource.credentials": "Zugangsdaten",
  "permission.resource.vault": "Tresor",
  "permission.resource.discovery": "Erkundung",
  "permission.resource.engine": "Engine",
  "permission.resource.inboundHooks": "Eingehende Hooks",
  "permission.resource.intake": "Gesammelte Einträge",
  "permission.resource.mcp": "MCP",
  "permission.resource.mcpClients": "MCP-Clients",
  "permission.resource.metrics": "Metriken",
  "permission.resource.packages": "Pakete",
  "permission.resource.portalTokens": "Portal-Token",
  "authority.refusal.no_boundary":
    "Für diesen Schritt ist noch keine Grenze geprüft — nichts sagt, wohin er darf und wie groß er werden darf.",
  "authority.refusal.stricter_profile_applies":
    "Dieser Schritt ist eine Bericht-E-Mail oder eine Veröffentlichung. Dafür gibt es eine eigene, strengere Prüfung des Empfängers bzw. der veröffentlichten Einträge; eine allgemeine Grenze gehört hier nicht hin.",
  "authority.trial.title": "Probe-Run läuft",
  "authority.trial.what":
    "Dieser Probe-Run liest wirklich aus deinen verbundenen Systemen und hält jeden Schreibzugriff zurück, sodass dort nichts geändert wird.",
  "authority.trial.elapsed": "Läuft seit {seconds} Sekunden.",
  "authority.trial.alreadyRunning":
    "Für diesen Workflow läuft bereits ein Probe-Run — vermutlich in einem anderen Tab. Dieser wartet darauf, statt einen zweiten zu starten.",
  "authority.sample.title": "Ein Beispielaufruf von „{slug}“ wird gebraucht",
  "authority.sample.what":
    "Der Webhook „{slug}“ startet diesen Workflow, und seine abgewiesenen Aufrufe werden nicht aufbewahrt. Der Probe-Run braucht einen Aufruf, wie er ankäme — gesendet wird nichts. Im Feld steht der letzte Aufruf, den dieser Workflow erhalten hat, oder eine leere Vorlage: Trage ein, was der Absender wirklich liefert.",
  "authority.sample.label": "Beispielaufruf (JSON)",
  "authority.sample.invalid": "Das ist kein gültiges JSON.",
  "authority.sample.schema":
    "Das Beispiel passt nicht zur erwarteten Eingabe des Workflows: {detail}",
  "authority.sample.prepare": "Probe-Run mit diesem Aufruf starten",
  "authority.refusal.report_delivery_unprepared":
    "Dieser Schritt verschickt einen Bericht per E-Mail, und noch niemand hat ihm dabei zugesehen. Ein Probe-Run — der alles zurückhält, was er senden würde — zeigt, wer ihn bekäme, und genau das wird freigegeben.",
  "authority.refusal.report_delivery_unobserved":
    "Ein Probe-Run hat diesen Schritt erreicht, aber keinen Empfänger festgehalten — es gibt also noch nichts freizugeben. Öffne diesen Run und sieh dir den Schritt an: die Adresse wurde vermutlich nie ermittelt.",
  "authority.refusal.report_delivery_unreachable":
    "Ein Probe-Run ist nie bis zu diesem Schritt gekommen, also hat niemand gesehen, wer die E-Mail bekäme. Ein weiterer Probe-Run hilft nicht, wenn der Schritt erst erreicht wird, nachdem etwas gesendet wurde — genau das hält ein Probe-Run zurück. Nenne den Empfänger stattdessen am Schritt selbst; was tatsächlich gesendet wird, wird weiterhin jedes Mal dagegen geprüft.",
  "authority.refusal.target_unresolved":
    "Das Ziel lässt sich nicht ermitteln: Der Connector hat keine Basisadresse und der Pfad ist keine vollständige Adresse.",
  "authority.refusal.path_unsupported":
    "Die Adresse ist so zusammengesetzt, dass eine Grenze sie nicht Abschnitt für Abschnitt beschreiben kann.",
  "authority.refusal.partial_segment_placeholder":
    "Ein Platzhalter deckt nur einen Teil eines Adressabschnitts ab. Eine Grenze kann einen ganzen Abschnitt benennen, kein Stück davon.",
  "authority.refusal.runtime_header":
    "Ein Kopffeld wird zur Laufzeit in einer Form gefüllt, die eine Grenze nicht beschreiben kann.",
  "authority.refusal.header_boundary_mismatch":
    "Die Grenze benennt andere Kopffelder als der Schritt zur Laufzeit tatsächlich füllt.",
  "authority.refusal.runtime_value_outside_path_and_body":
    "Ein Laufzeitwert steht an anderer Stelle als in Adresse oder Inhalt. Dort gibt es nichts, womit man ihn begrenzen könnte.",
  "authority.refusal.query_placeholder_unsupported":
    "Ein Abfrageparameter wird zur Laufzeit in einer Form gefüllt, die eine Grenze nicht beschreiben kann.",
  "authority.refusal.pagination_unbounded":
    "Dieser Schritt blättert ohne Obergrenze durch Ergebnisse — die Zahl der Anfragen ist offen.",
  "authority.refusal.pagination_param_conflict":
    "Die Blätter-Parameter widersprechen der Grenze, die sie abdecken soll.",
  "authority.refusal.delete_requires_destructive":
    "Dieser Schritt entfernt Daten. Eine Grenze deckt das nur ab, wenn sie es ausdrücklich sagt.",
  "authority.refusal.delete_requires_enum":
    "Eine Entfernung muss genau benennen, was sie entfernen darf — kein Muster.",
  "authority.refusal.created_by_workflow_misplaced":
    "Nur eine Entfernung über einen Connector darf ein Pfadsegment auf IDs begrenzen, die dieser Workflow angelegt hat.",
  "authority.refusal.variable_in_base_prefix":
    "Ein Platzhalter steht im festen Teil der Adresse. Damit könnte sich das Ziel selbst verschieben.",
  "authority.refusal.enum_value_unroutable":
    "Einer der erlaubten Werte führt nirgendwohin, das dieser Connector erreichen kann.",
  "authority.refusal.boundary_invalid":
    "Die Grenze an diesem Schritt ist so, wie sie dasteht, nicht lesbar.",
  "authority.refusal.variables_mismatch":
    "Die Grenze benennt andere Platzhalter als der Schritt tatsächlich verwendet.",
  "authority.refusal.not_http_step": "Diese Art von Schritt kann noch keine Grenze tragen.",
  "authority.refusal.no_scope":
    "Für diesen Speicher-Schritt ist kein Ordner geprüft — nichts sagt, auf welche Dateien er zugreifen darf.",
  "authority.refusal.scope_invalid":
    "Der Ordner an diesem Schritt ist so, wie er dasteht, nicht lesbar.",
  "authority.refusal.unsupported_method":
    "Dieser Speichervorgang lässt sich für wiederkehrende Runs noch nicht prüfen.",
  "authority.refusal.delete_with_body":
    "Eine Entfernung, die zugleich Inhalt sendet, lässt sich nicht als Entfernung prüfen.",
  "authority.refusal.runtime_value_outside_key":
    "Ein Laufzeitwert steht an anderer Stelle als im Dateinamen — der Ordner kann ihn nicht abdecken.",
  "authority.refusal.query_or_headers_present":
    "Dieser Speicher-Schritt sendet Abfrageparameter oder Kopffelder. Ein Ordner beschreibt so etwas nicht.",
  "authority.refusal.unsupported_option":
    "Dieser Schritt nutzt eine Speicher-Option, die die geprüfte Form nicht abdeckt.",
  "authority.refusal.content_type_invalid":
    "Der angegebene Inhaltstyp ist so, wie er dasteht, nicht lesbar.",
  "authority.refusal.base_unresolved":
    "Die Speicheradresse lässt sich aus diesem Connector nicht ermitteln.",
  "authority.grantSaved": "Freigabe gespeichert. Der Entscheidungsstatus wurde aktualisiert.",
  "authority.headline.runs.one": "bis zu {max} Run",
  "authority.headline.runs.other": "bis zu {max} Runs",
  "authority.headline.until": "gültig bis {until}",
  "permission.labelAll": "{resource} · {action} (alle Personen)",
  "permission.actionAll": "{action} (alle Personen)",
  "permission.labelGlobal": "{resource} · {action} (ganze Engine)",
  "permission.actionGlobal": "{action} (ganze Engine)",
  "permission.resource.apiKeys": "API-Schlüssel",
  "permission.resource.mcpExternalTools": "Externe MCP-Werkzeuge",
  "permission.resource.memory": "Gesprächsgedächtnis",
  "permission.resource.connections": "Kontoverbindungen",
  "permission.resource.schedules": "Zeitpläne",
  "permission.resource.tasks": "Aufgaben",
  "permission.resource.devices": "Geräte",
  "permission.resource.localSteps": "Schritte auf einem Gerät",
  "permission.resource.taskRuns": "Runs von Aufgaben",
  "permission.action.grant": "Dauererlaubnis geben",
  "permission.resource.subscriptions": "Abonnements",
  "permission.action.commit": "Festschreiben",
  "permission.action.export": "Exportieren",
  "permission.action.import": "Importieren",
  "permission.action.invoke": "Aufrufen",
  "permission.action.pause": "Pausieren",
  "permission.action.propose": "Vorschlagen",
  "permission.action.replay": "Erneut abspielen",
  "permission.action.restore": "Wiederherstellen",
  "permission.action.resume": "Fortsetzen",
  "authority.refusal.report_delivery_contradicted":
    "Ein Probe-Run hat diesen Schritt erreicht, und die E-Mail, die er verschickt hätte, passt nicht zu dem, was am Schritt angegeben ist: Die Nachricht liegt außerhalb des Berichtsformats oder geht an eine andere Adresse. So angegeben würde jeder Run beim Senden abgewiesen. Passe den Schritt oder seine Angabe an, damit beides übereinstimmt.",
  "authority.inactiveVersion": "Gilt für eine Version, die nicht läuft.",
};
