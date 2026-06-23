# `/support` — App Support Agent Skill

**Status:** Approved (design) — 2026-06-23
**Author:** Jordan Waters (1waterrj fork)
**Scope:** A new vendor-neutral gstack skill that triages incoming app support
requests, drafts customer replies grounded in real investigation, and rolls up
ticket data into a Product/Engineering digest (sentiment + contract/churn risk).

## Problem

Solo builders and small teams field support requests that need: (1) fast,
correct triage and a grounded reply, and (2) a periodic signal to Product/Eng
about what's hurting customers — themes, sentiment trend, and contract/churn
risk. gstack has the pieces (`/investigate` for root cause, the redaction guard
for external sinks, append-only log bins) but no skill that wraps them into a
support workflow. This adds one.

The skill must be **generic and cloneable** — no vendor (Zendesk, Pylon, etc.)
hardcoded. It just happens to fit the author's workflow; anyone who clones
gstack can use it.

## Goals

- One skill, `/support`, with three modes: per-ticket, `--queue` (batch),
  `--rollup` (digest).
- Reuse `/investigate` for repro/root-cause, the redaction guard for every
  external-bound or persisted string, and gstack's append-only log pattern.
- Vendor-neutral intake: zero-setup default (paste/file/URL) plus optional
  CLAUDE.md-configured commands (gstack's read→ask→persist platform-agnostic
  rule).
- Replies are **drafted, never auto-sent** in v1.
- Roll-up produces a markdown digest file and offers a redaction-guarded GitHub
  issue; degrades to file-only without `gh`.
- Privacy-respecting support log: content-light, redacted (mirrors the
  decision-log "content-free record" stance).

## Non-Goals (v1)

- Sending replies to customers (needs a vendor send-integration + stronger
  guardrails). Out of scope.
- A specific ticketing-vendor integration shipped in-repo. The intake is
  configurable; no vendor adapter is bundled.
- Auto-creating one GitHub issue per ticket. Roll-up is aggregate.

## Design

### Skill shape

`support/SKILL.md.tmpl` (generated to `support/SKILL.md` by `gen-skill-docs`),
following the existing skill template conventions (frontmatter: `name: support`,
`preamble-tier: 2`, `version`, `description` with trigger phrases,
`allowed-tools`, `triggers`). It is a prompt template read by the agent, not a
program (per gstack's "Writing SKILL templates" rules: natural-language logic,
self-contained bash blocks, conditionals as numbered English steps).

Routing/trigger phrases: "handle this support ticket", "triage this", "draft a
reply to this customer", "support rollup", "what are customers complaining
about".

Once the Cursor port (separate, already merged) is in place, `/support`
automatically gets a `/gstack-support` Cursor command from the generator — no
extra work.

### Modes

1. **`/support <ticket>` (per-ticket, default)**
   1. Acquire the ticket (see Intake).
   2. Classify: category, priority, sentiment, contract-risk (see
      Classification).
   3. Investigate: delegate to `/investigate` for anything that needs repro /
      root cause (errors, "broken", "not working"). For pure how-to / account
      questions, skip straight to drafting.
   4. Draft a customer reply grounded in the investigation. Never fabricate a
      fix or a ship date. If the answer needs eng input or isn't resolvable from
      available evidence, the draft says so and lists what's needed.
   5. Run the draft through the redaction guard (scan-at-sink) before showing
      it.
   6. Append a redacted record to the support log.
   7. Present the draft + classification to the user. Sending is the user's
      manual step.

2. **`/support --queue` (batch)**
   - Require a configured `support_list` command (else instruct the user to set
     one). It returns open ticket IDs.
   - For each ID: `support_fetch <id>` → run the per-ticket chain (steps 2–6
     above) → collect a one-line outcome.
   - Drafts are written for the user's review (e.g., to
     `~/.gstack/projects/<slug>/support-drafts/<ticket_ref>.md`), **never
     auto-sent**.
   - Print a batch summary table (ticket_ref, category, priority, sentiment,
     contract_risk, draft path).

3. **`/support --rollup [--since <window>]` (digest)**
   - Read `support.jsonl`, filter by window (default 30d).
   - Aggregate: top themes (by `theme_tags`), sentiment trend, priority mix,
     and a ranked contract/churn-risk list with the reasons recorded per ticket.
   - Write a markdown digest to
     `~/.gstack/projects/<slug>/support-rollups/<date>.md`.
   - Offer (AskUserQuestion) to also open a GitHub issue tagging product/eng,
     with the digest body scanned by the redaction guard (scan the exact bytes,
     pass the same file to `gh`). If `gh` is unavailable, file-only with a note.

### Intake (vendor-neutral, platform-agnostic rule)

Resolution order for a ticket:
1. Inline content the user pasted, or a file path / URL argument → use directly.
2. A `support_fetch` command in CLAUDE.md → run it with the ticket id.
3. Neither present and an id was given → AskUserQuestion: paste the ticket, give
   a file/URL, or configure `support_fetch`. Persist a provided command to
   CLAUDE.md so it's not asked again.

`--queue` additionally needs `support_list` (same read→ask→persist treatment).
No vendor is hardcoded; the commands are whatever the team wires (a curl, a CLI,
a `cat file.csv`).

### Canonical ticket contract (interlock point)

To keep intake well-defined regardless of source — and so a future in-app
**ticket-submission scaffolder** (separate skill, see Follow-ups) can emit
tickets `/support` ingests with zero glue — the skill defines a canonical
inbound ticket shape. `support_fetch <id>` should return one such object (JSON
on stdout); `support_list` returns an array of ids or `{id, subject}` objects.
The skill is tolerant: missing optional fields are fine, and free-form text
(paste) is accepted and mapped onto `subject`/`body` heuristically.

```json
{
  "id": "string (source ticket id)",
  "subject": "string",
  "body": "string (the customer's message)",
  "channel": "email | web | chat | other (optional)",
  "created_at": "ISO8601 (optional)",
  "customer_ref": "opaque id or email — used for dedupe/repeat detection only, never persisted raw (optional)",
  "metadata": { "free": "object (optional)" }
}
```

This contract is documentation + a parser in the skill; it is intentionally NOT
a hard schema validator (a clone's source may be a CSV row). The scaffolder
piece will generate an in-app submission feature that POSTs/writes exactly this
shape, so the loop closes: app collects ticket → `support_fetch` reads it →
`/support` triages.

### Classification

On intake the agent assigns, from the ticket text:
- `category` — free-tagged (bug, how-to, billing, outage, feature-request,
  account, other).
- `priority` — P0–P3 from impact + urgency language.
- `sentiment` — `frustrated | neutral | satisfied` plus an intensity 1–3, from
  urgency/frustration/satisfaction cues.
- `contract_risk` — boolean + short reason. Fires on: explicit
  churn/cancellation language, contract/renewal mentions, escalation threats
  ("talking to my manager", "considering alternatives"), or a repeat of an
  already-logged unresolved theme.
- `theme_tags[]` — short normalized tags for roll-up grouping.
- `one_line_summary` — content-light, PII-scrubbed.

### Support log

Append-only `~/.gstack/projects/<slug>/support.jsonl`, one JSON object per
handled ticket. Privacy stance mirrors `gstack-decision-log`: store the
classification + a content-light summary, NOT the raw customer text. Every write
goes through the redaction engine; a HIGH finding blocks the write.

Record schema:
```json
{
  "ts": "<ISO8601, stamped by gstack-support-log on write>",
  "ticket_ref": "<id or salted hash>",
  "category": "bug",
  "priority": "P2",
  "sentiment": "frustrated",
  "sentiment_intensity": 2,
  "contract_risk": true,
  "contract_risk_reason": "mentioned evaluating competitor",
  "theme_tags": ["import-fails", "csv"],
  "one_line_summary": "CSV import 500s on files over 10MB",
  "status": "drafted"
}
```

A small bin helper (`bin/gstack-support-log`) appends records the same way
`gstack-decision-log` / `gstack-timeline-log` do — non-interactive,
injection-sanitized, HIGH-secret-blocking on write — so the SKILL template calls
a helper instead of hand-rolling jsonl writes. A reader path (filter by window,
`--json`) backs `--rollup`.

### Outputs & safety

- **Reply drafts**: grounded, no fabricated fixes/dates, explicit "needs eng"
  flagging, redaction-scanned before display. Never sent in v1.
- **Roll-up**: markdown file always; GitHub issue optional, redaction-guarded,
  visibility-aware (public repos get sterner confirmation, per the existing
  redaction visibility rules).
- All external/persisted strings (replies, issue bodies, log records) are
  scanned at the sink with the existing `bin/gstack-redact` engine.

## Components / files

- `support/SKILL.md.tmpl` + generated `support/SKILL.md` — the skill.
- `bin/gstack-support-log` — append + read helper (jsonl), modeled on
  `bin/gstack-decision-log`. Single responsibility: persist/read support
  records with redaction-on-write.
- `test/support-skill.test.ts` — static validation: log-record shape,
  redaction-on-write blocks a planted secret, classification fields present on
  fixtures, roll-up window filtering, no vendor strings hardcoded in the
  template.
- README skill-list + routing entry; CLAUDE.md skill-routing line.

## Testing

Follows gstack's free tiers (no paid evals required for v1):
- Skill validation (template frontmatter, trigger phrases) — picked up by the
  existing parameterized `test/skill-validation.test.ts`.
- `gen-skill-docs` freshness — the new skill generates for all hosts via the
  existing parameterized smoke tests (zero new test code there).
- `test/support-skill.test.ts`: `gstack-support-log` append/read round-trip;
  redaction blocks a HIGH secret on write; roll-up `--since` filtering; record
  schema; template contains no hardcoded vendor host/endpoint.

Manual verification: run `/support` on a sample ticket (paste), confirm a draft
+ a logged record; run `/support --rollup` and confirm the digest file.

## Risks / tradeoffs

- **Classification is heuristic**, done by the agent from text — not a trained
  model. Acceptable: it's advisory triage, and the reply/rollup are
  human-reviewed. Documented as such.
- **Contract-risk false positives.** Tuned to flag-with-reason rather than
  silently escalate; the human reads the reason in the roll-up.
- **Privacy.** Raw customer text is never persisted; only redacted
  classification + summary. Log lives under `~/.gstack` (never committed).
- **Scope creep toward auto-send.** Explicitly deferred; v1 drafts only.

## Out of scope / follow-ups

- A bundled vendor adapter (Zendesk/Pylon/etc.) or an auto-send mode.
- Trained sentiment model; cross-project support analytics.
- **In-app ticket-submission scaffolder** (planned 3rd piece, own spec): a skill
  that builds a support-intake feature (form/endpoint/store) into the user's app,
  framework-agnostic (reads the stack from CLAUDE.md), emitting tickets in the
  Canonical ticket contract above so `/support` ingests them with no glue.
- Optional later: feed roll-up themes into `/office-hours` or `/plan-ceo-review`
  for prioritization.
