# Why these primitives

> **Reading time:** ~9 min
> **Audience:** Anyone deciding whether a retry loop, an approval gate or an audit log is worth owning — and anyone who suspects the answer is "it depends on what breaks"

**A feature list says what a primitive does. This page says what it prevents.** Every entry below is a failure that actually happened in this product's own operation, with the number that was measured and the commit or changelog entry that recorded it. Nothing here is reconstructed; where the history does not carry an origin, the page says so instead of inventing one.

That honesty has a shape worth knowing before you read. The repository's public history begins with a single squashed commit. For most primitives — the audit log itself, encrypted credentials, execution history, the sandbox choice, scheduling, the retry policy — there is therefore no origin story on record. What the record carries instead, in unusual detail, is every time one of them *turned out to be insufficient*. Those are the stories below, and they are better than origin stories: an origin explains why someone thought a primitive was needed; a repair proves it.

---

## The environment fallback that shipped writes to the wrong system

**What it prevents:** a production run silently using development credentials.

Connectors carry an environment. When a production run found no production binding, the resolver fell back to the development connector and dispatched anyway, logging a warning. That is a reasonable behaviour for a read. It is not reasonable for a write.

> Production logs show 769 `connector.environment.fallback` events (requested "dev" resolved "prod" on connector `subkit-prod`) — including writes shipped through the wrong-environment binding with nothing but a grep-able warn.
> — commit `4c5a27ab`, 2026-07-19

Since then a write-classified step hard-fails with `connector_environment_mismatch`; reads keep the fallback. The number to remember is 769: that is how many times a warning was the only thing standing between two environments, and how many times nobody read it.

**The primitive:** environment-bound connectors, and the distinction between a read and a write. Neither is decoration.

---

## The audit export that lost rows without saying so

**What it prevents:** an export that is well-formed, ends normally, and is missing a sixth of the data.

An audit trail is only worth its name if what you export is what was written. The export paginated on a timestamp with a strict less-than, and the engine stamps timestamps from the JavaScript clock at millisecond precision while PostgreSQL keeps microseconds.

> Measured against a 600-row snapshot sharing one timestamp: the export emitted 500. It ended normally, the stream was well-formed, and nothing reported a gap — the loss is only visible against `count(*)`.
> — commit `ab5af65a`, 2026-08-22

The cursor became a keyset over `(timestamp, id)`. The same commit disclosed an unfixed sibling with its own measurement — six of fifteen rows walked by the query path — rather than leaving it to be found.

**The primitive:** append-only audit entries with a stable identity per row. The identity is what makes an export provably complete; a timestamp alone never was.

---

## The second writer that bypassed the scrubber

**What it prevents:** a secret reaching the audit table through a door the redaction never covered.

The audit writer scrubs secrets before an entry lands. It was never the only writer: a second path inserted directly into the same table, from roughly thirty-two call sites, without scrubbing.

> before — audit(): prompt=ok, api_token=ok, body=LEAK · audit_write(): prompt=LEAK, api_token=LEAK, body=LEAK … 4 of 6 leaked, now 0 of 6.
> — commit `8912f825`, 2026-08-22

The fix was not a second call to the scrubber at the second site — the commit rejects that explicitly, because it "would have fixed that site and nothing else". The rule moved into the table boundary, applied again at write time regardless of which writer got there, and an invariant now fails the build on any new direct insert.

**The primitive:** one writer, one boundary. An audit log with two doors has zero.

---

## The approval that never resolved

**What it prevents:** a human saying yes and the system recording that nobody answered.

Approval before a side effect is the product's central promise. For a while it was a promise the mechanism could not keep.

> Across the whole history of the feature, 0 of 5 approval-backed confirms had ever resolved in production. … `expires_at` was set from mint time, so a human who deliberated for 14 of their 15 minutes left the harness one second to claim in.
> — commit `017d37ce`, 2026-07-25

Three repairs followed, each with its own measurement. The grant did not name the person who gave it — `granted_by_user_id` was null on every grant, so possession of a forwarded link decided a write, unattributably. The window was fifteen minutes, which a review queue read an hour later found already expired: "a review queue whose items die before anyone can read them is not a review queue" (commit `c277f1e2`). And the whole gate had earlier been rebuilt after an audit found in-band elicitation "0/29 fulfilled in prod" and a model-callable confirm that was "a self-approval path wearing the costume of a gate" (commit `a06ef6f8`, 2026-07-08).

**The primitive:** an approval that is minted ungranted, granted only by a person through a channel the model cannot reach, attributed to that person, and alive for as long as a person plausibly needs. Every clause in that sentence was once missing.

---

## The catch-up storm after an outage

**What it prevents:** a ten-minute outage producing ten runs.

A scheduler that fires on "is it due" alone will, after coming back, find every missed minute due at once.

> Cron reconciler dedup: new `last_enqueued_at` column on schedules; reconciler skips when the time since the last enqueue is less than the cron's expected period. Prevents the 10x-fire storm pattern after a 10-minute outage.
> — commit `d9125c7a`, 2026-04-27

The code still explains it in its own words: a schedule brought back ten minutes behind "therefore produces ONE catch-up enqueue, not 10". The stamp was later made safe across multiple engine replicas with a compare-and-set, and stamped before the enqueue so a crash in between cannot double-fire.

**The primitive:** scheduling that remembers what it already started. The naive version is not wrong on a good day; it is wrong on the day after a bad one.

---

## The locale that shipped a wrong percent sign

**What it prevents:** a transform producing different output on the engine than on the laptop where it was written, silently.

The sandbox has no locale support at all. It used to accept a locale argument and ignore it, returning C-locale output that looked right in development.

> Passing a locale or an options object to `toLocaleString` throws since stdlib 1.7.0: QuickJS accepts both and ignores both, so the call used to return C-locale output that looked right in Node and shipped "+9.2 %" to a German production page.
> — the sandbox's own reference, dated by the 6.0.0 changelog, 2026-07-30

The overloads now throw instead of quietly falling back. The changelog names the actual hazard: not that formatting differed, but that "the sandbox has no ECMA-402 at all, making the difference silent rather than loud".

**The primitive:** a sandbox whose restrictions fail loudly. Every capability it lacks is a capability it refuses, not one it fakes.

---

## The recovery that recovered nothing

**What it prevents:** an audit trail asserting something the system did not do.

This is the most recent entry, and the rarest kind: a documented removal.

The boot sweep for interrupted waits re-enqueued the execution and recorded the wait as completed and recovered. The execution could never start — the state transition it needed only applies to queued runs, and a crashed run is still marked running. Had it started, it would have begun at the first step and repeated every side effect already performed.

> So the audit trail asserted a recovery that never happened, which is worse than the missing feature: an operator reading `wait.completed` had no way to know the run was dead.
> — the sweep's own header, commit `4864cf0a`, 2026-09-02

The sweep now records `wait.abandoned`, the capability matrix says a crashed run is not continued, and this page says it too. A primitive that overstates itself is a liability; the honest scope of crash recovery in this product is: the run is terminalized, recorded and audited — not resumed.

**The primitive:** a crash sweep that tells the truth. Sometimes the right fix for a primitive is to make it claim less.

---

## What has no origin story, and why that is said out loud

| Primitive | Status of the record |
|---|---|
| Execution history as durable records | Present from the first public commit; no failure recorded for its existence |
| Inbound webhook replay protection | Mechanism documented; cause not |
| The audit log itself | Only its repairs are documented — three of them above |
| Encrypted credentials | The threat model is stated inline; no incident is |
| QuickJS as the sandbox | Only its restrictions carry causes |
| Retry and backoff numbers | Documented; their derivation is not |

These are listed rather than filled in. A plausible reconstruction would read well and prove nothing, and this page's only value is that every number on it was measured.

---

## What to take from this

The pattern across every entry: the primitive existed, and it was still insufficient in a way that only production revealed — a warning nobody read, an export nobody counted, a gate nobody could pass, a recovery nobody checked. That is the argument for owning these primitives as product rather than as a folder of helpers in each project: not that they are hard to write, but that they are hard to keep honest, and the only way to find out is to run them for real.

If you are deciding whether to build these yourself, [When to use sk — and when not to](./when-to-use.md) is the page for the decision; the [capability matrix](../developers/capabilities.md) is the page for what exists today, including what does not.
