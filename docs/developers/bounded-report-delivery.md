# Scheduled report decisions

A saved draft, successful held preview and one-off send do not authorize future
scheduled deliveries. The chat reads schedule readiness from the server and keeps
the blocked schedule in Decisions until a matching human execution authority is
persisted and its admission hold is resolved.

The chat review prepares missing report evidence with writes held, then presents
the fixed sender, recipient, next scheduled time and finite run/expiry bounds.
Confirming may atomically activate the exact reviewed draft and grant its bounds.
It does not send a report immediately. Completion refreshes the decision queue and
server readiness; reload uses the same persisted state.

The supported variable-content profile is deliberately narrow: Gmail HTTP POST
`/gmail/v1/users/me/messages/send`, one fixed sender and recipient, UTF-8 plain text
or HTML, changing subject/body, no additional recipients, forwarding headers or
attachments. A successful held run provides a proposal, not authority. The human
review binds that proposal in the immutable effect manifest. Runtime dispatch
checks the actual decoded message against that manifest before egress.

HTTP GET query substitutions may vary only explicitly declared query keys at a
fixed endpoint. Other query values, method, connector configuration, credentials,
version and environment remain bound. Dynamic destinations, other write bodies,
subworkflow effects and unsupported MIME still require their own supported review.
A preview cannot broaden a previously approved report boundary.

Preparation is `POST /v1/workflows/{id}/versions/{version_id}/prepare-authority`;
readiness is `GET /v1/workflows/{id}/automation-status`. Neither endpoint grants
permission. The existing browser-session/CSRF authority endpoint remains the sole
human confirmation path. Revocation, expiry and exhaustion block future dispatch.

Regression coverage includes held preparation, human grant, schedule resolution,
changing report contents, recipient deviation, tenant/environment isolation,
revocation/expiry/exhaustion and chat confirmation/counter/reload behavior. Runtime
logs distinguish held previews from sent reports; no real business email is sent
by verification fixtures.
