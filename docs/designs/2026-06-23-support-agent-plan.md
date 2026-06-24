# `/support` App Support Agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a vendor-neutral `/support` gstack skill that triages a ticket → investigates → drafts a customer reply → logs a redacted record, plus a `--queue` batch mode and a `--rollup` Product/Eng digest.

**Architecture:** A prompt-template skill (`support/SKILL.md.tmpl`) orchestrating existing gstack capabilities (`/investigate`, redaction guard) and a new append/read log helper (`bin/gstack-support-log`, modeled on `bin/gstack-decision-log`). The skill is auto-discovered by `gen-skill-docs` (all hosts) and `gen-cursor-commands` — no registration needed.

**Tech Stack:** TypeScript/Bun (bin helper), gstack SKILL template conventions, `bun:test`.

## Global Constraints

- **Vendor-neutral / cloneable.** No ticketing vendor (Zendesk/Pylon/etc.) hardcoded in the template or helper. Intake is paste/file/URL by default; optional `support_fetch`/`support_list` commands read from CLAUDE.md (read→ask→persist).
- **Drafts only.** Replies are drafted for human review; the skill never sends. No vendor send-integration in v1.
- **Redaction-on-write at every sink.** Reply drafts shown to the user, the roll-up issue body, and every `support.jsonl` write go through the redaction engine; a HIGH finding (or oversize) blocks the persisted/external write.
- **Content-light log.** `~/.gstack/projects/<slug>/support.jsonl` stores classification + a PII-scrubbed one-line summary, never raw customer text. Never committed (`~/.gstack` is outside the repo).
- **Canonical inbound ticket contract** (from the spec): `{ id, subject, body, channel?, created_at?, customer_ref?, metadata? }`. `support_fetch <id>` returns one such JSON; `support_list` returns ids or `{id, subject}`. Tolerant parser; pasted free text maps onto subject/body.
- **Reuse, don't reinvent.** Root cause → invoke `/investigate`. Redaction → `lib/redact-engine` `scan()`. Slug/flags → `lib/bin-context`.
- **Record schema** (verbatim): `ts, ticket_ref, category, priority, sentiment, sentiment_intensity, contract_risk, contract_risk_reason, theme_tags[], one_line_summary, status`.

---

### Task 1: `bin/gstack-support-log` — append + read helper

**Files:**
- Create: `bin/gstack-support-log`
- Test: `test/support-log.test.ts`

**Interfaces:**
- Produces (CLI):
  - `gstack-support-log append '<json record>'` → stamps `ts`, redaction-scans `one_line_summary` + `contract_risk_reason`, appends one JSON line to `~/.gstack/projects/<slug>/support.jsonl`. Exits non-zero and writes nothing if a HIGH finding or oversize is detected, or required fields are missing.
  - `gstack-support-log read [--since <window>] [--json]` → prints matching records (JSON array with `--json`, else a table). `<window>` is like `30d`, `7d`, `24h`, `90m`.
- Path root: `process.env.GSTACK_HOME || ~/.gstack`, then `projects/<slug>/support.jsonl`.

- [ ] **Step 1: Write the failing test**

Create `test/support-log.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-support-log');

function run(args: string[], home: string) {
  return Bun.spawnSync(['bun', BIN, ...args], {
    env: { ...process.env, GSTACK_HOME: home, PATH: process.env.PATH ?? '' },
    cwd: ROOT,
  });
}
function logFile(home: string): string | null {
  const projects = path.join(home, 'projects');
  if (!fs.existsSync(projects)) return null;
  for (const slug of fs.readdirSync(projects)) {
    const f = path.join(projects, slug, 'support.jsonl');
    if (fs.existsSync(f)) return f;
  }
  return null;
}

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-support-')); });

const cleanRecord = JSON.stringify({
  ticket_ref: 'T-1', category: 'bug', priority: 'P2',
  sentiment: 'frustrated', sentiment_intensity: 2,
  contract_risk: true, contract_risk_reason: 'mentioned evaluating a competitor',
  theme_tags: ['csv', 'import-fails'], one_line_summary: 'CSV import 500s over 10MB',
  status: 'drafted',
});

describe('gstack-support-log', () => {
  test('append writes one line, stamps ts, preserves fields', () => {
    const r = run(['append', cleanRecord], home);
    expect(r.exitCode).toBe(0);
    const f = logFile(home)!;
    expect(f).toBeTruthy();
    const lines = fs.readFileSync(f, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(1);
    const rec = JSON.parse(lines[0]);
    expect(rec.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(rec.category).toBe('bug');
    expect(rec.contract_risk).toBe(true);
    expect(rec.theme_tags).toEqual(['csv', 'import-fails']);
  });

  test('append BLOCKS a HIGH secret in the summary and writes nothing', () => {
    const dirty = JSON.stringify({
      ticket_ref: 'T-2', category: 'bug', priority: 'P1',
      sentiment: 'neutral', sentiment_intensity: 1, contract_risk: false,
      contract_risk_reason: '', theme_tags: ['auth'],
      one_line_summary: 'user pasted their key AKIAIOSFODNN7EXAMPLE in the ticket',
      status: 'drafted',
    });
    const r = run(['append', dirty], home);
    expect(r.exitCode).not.toBe(0);
    expect(logFile(home)).toBeNull();
  });

  test('append rejects a record missing required fields', () => {
    const r = run(['append', JSON.stringify({ category: 'bug' })], home);
    expect(r.exitCode).not.toBe(0);
  });

  test('read --since filters by window and --json returns an array', () => {
    run(['append', cleanRecord], home);
    const recent = run(['read', '--since', '30d', '--json'], home);
    expect(recent.exitCode).toBe(0);
    const arr = JSON.parse(recent.stdout.toString());
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.length).toBe(1);
    expect(arr[0].ticket_ref).toBe('T-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/support-log.test.ts`
Expected: FAIL — `bin/gstack-support-log` does not exist (spawn error / non-zero).

- [ ] **Step 3: Write the helper**

Create `bin/gstack-support-log` (and `chmod +x` it in Step 4's commit):

```typescript
#!/usr/bin/env bun
/**
 * gstack-support-log — append a redacted support record, or read records.
 *
 * Usage:
 *   gstack-support-log append '<json record>'
 *   gstack-support-log read [--since <window>] [--json]
 *
 * NON-INTERACTIVE. Stamps ts on append. Scans one_line_summary +
 * contract_risk_reason with the redaction engine; a HIGH finding or oversize
 * input exits 1 and writes nothing. Content-light by contract: callers pass a
 * PII-scrubbed summary, never raw customer text.
 *
 * Record: { ts, ticket_ref, category, priority, sentiment, sentiment_intensity,
 *           contract_risk, contract_risk_reason, theme_tags[], one_line_summary, status }
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { resolveSlug, flagValue } from '../lib/bin-context';
import { scan } from '../lib/redact-engine';

const HERE = import.meta.dir;
const args = process.argv.slice(2);
const cmd = args[0];

const slug = resolveSlug(`${HERE}/gstack-slug`);
const home = process.env.GSTACK_HOME || join(homedir(), '.gstack');
const logPath = join(home, 'projects', slug, 'support.jsonl');

const REQUIRED = ['ticket_ref', 'category', 'priority', 'one_line_summary'];

function parseSince(win: string | undefined): number | null {
  if (!win) return null;
  const m = win.match(/^(\d+)([dhm])$/);
  if (!m) { console.error(`invalid --since '${win}' (use e.g. 30d, 24h, 90m)`); process.exit(1); }
  const n = Number(m[1]);
  const ms = m[2] === 'd' ? 86_400_000 : m[2] === 'h' ? 3_600_000 : 60_000;
  return n * ms;
}

if (cmd === 'append') {
  let rec: Record<string, unknown>;
  try { rec = JSON.parse(args[1] ?? ''); }
  catch { console.error('append: argument must be a JSON object'); process.exit(1); }

  for (const k of REQUIRED) {
    if (rec[k] === undefined || rec[k] === null || rec[k] === '') {
      console.error(`append: missing required field '${k}'`); process.exit(1);
    }
  }

  // Redaction-on-write: scan only the free-text fields, fail closed on HIGH/oversize.
  const probe = `${rec.one_line_summary ?? ''}\n${rec.contract_risk_reason ?? ''}`;
  const result = scan(probe);
  if (result.oversize || result.counts.HIGH > 0) {
    console.error('append: BLOCKED — HIGH-severity secret detected in summary/reason; nothing written.');
    process.exit(1);
  }

  rec.ts = new Date().toISOString();
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify(rec) + '\n');
  console.log(`logged ${rec.ticket_ref} → ${logPath}`);
  process.exit(0);
}

if (cmd === 'read') {
  if (!existsSync(logPath)) { console.log(flagValue(args, '--json') !== undefined ? '[]' : '(no support records yet)'); process.exit(0); }
  const sinceMs = parseSince(flagValue(args, '--since'));
  const cutoff = sinceMs ? Date.now() - sinceMs : null;
  const records = readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => cutoff === null || (r.ts && Date.parse(r.ts) >= cutoff));

  if (args.includes('--json')) {
    console.log(JSON.stringify(records, null, 2));
  } else {
    for (const r of records) {
      console.log(`${r.ts}  ${r.priority}  ${r.sentiment}  ${r.contract_risk ? 'RISK' : '    '}  [${(r.theme_tags || []).join(',')}]  ${r.one_line_summary}`);
    }
  }
  process.exit(0);
}

console.error('usage: gstack-support-log append \'<json>\' | read [--since <window>] [--json]');
process.exit(1);
```

Note on `flagValue`: it returns the value after a flag; for the boolean `--json` the code uses `args.includes('--json')` in `read`, and the empty-log branch checks `flagValue(args,'--json') !== undefined` only to pick `[]` vs prose — if `lib/bin-context`'s `flagValue` treats a trailing flag oddly, replace that one check with `args.includes('--json')` too. Confirm `flagValue`'s contract when implementing.

- [ ] **Step 4: Run tests + make executable, verify pass**

Run:
```
chmod +x bin/gstack-support-log
bun test test/support-log.test.ts
```
Expected: PASS (4/4). The HIGH-secret test relies on `AKIAIOSFODNN7EXAMPLE` matching an AWS-key HIGH pattern in `lib/redact-patterns.ts` — if the engine classifies that example string below HIGH, swap the fixture for a live-format HIGH credential the engine recognizes (check `lib/redact-patterns.ts` PATTERNS for a HIGH-tier shape) and keep the assertion.

- [ ] **Step 5: Commit**

```bash
git add bin/gstack-support-log test/support-log.test.ts
git commit -m "feat(support): add gstack-support-log append/read helper with redaction-on-write"
```

---

### Task 2: `support/SKILL.md.tmpl` skill + generation + static tests + docs

**Files:**
- Create: `support/SKILL.md.tmpl`
- Create (generated): `support/SKILL.md` (via `bun run gen:skill-docs`)
- Test: `test/support-skill.test.ts`
- Modify: `README.md` (skill list), `CLAUDE.md` (skill routing line)

**Interfaces:**
- Consumes: `bin/gstack-support-log` (Task 1); `/investigate` (existing skill); redaction CLI `bin/gstack-redact` (existing); `support_fetch`/`support_list` (user-configured, from CLAUDE.md).

- [ ] **Step 1: Write the failing test**

Create `test/support-skill.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const tmpl = fs.readFileSync(path.join(ROOT, 'support', 'SKILL.md.tmpl'), 'utf-8');

describe('support skill template', () => {
  test('has required frontmatter (name, tier, preamble token)', () => {
    expect(tmpl).toMatch(/^---\n[\s\S]*?\nname:\s*support\b/);
    expect(tmpl).toContain('preamble-tier: 2');
    expect(tmpl).toContain('{{PREAMBLE}}');
  });

  test('documents all three modes', () => {
    expect(tmpl).toContain('--queue');
    expect(tmpl).toContain('--rollup');
    // per-ticket default is described
    expect(tmpl.toLowerCase()).toContain('per-ticket');
  });

  test('reuses existing capabilities, not reinvented', () => {
    expect(tmpl).toContain('/investigate');
    expect(tmpl).toContain('gstack-support-log');
    expect(tmpl).toContain('gstack-redact');
  });

  test('is vendor-neutral — no hardcoded ticketing vendor', () => {
    expect(tmpl.toLowerCase()).not.toMatch(/\b(zendesk|freshdesk|intercom|pylon)\b/);
    expect(tmpl).toContain('support_fetch');
    expect(tmpl).toContain('support_list');
  });

  test('is drafts-only (no auto-send claim)', () => {
    expect(tmpl.toLowerCase()).toContain('never');
    expect(tmpl.toLowerCase()).toContain('draft');
  });

  test('generated SKILL.md exists and is in sync', () => {
    const md = path.join(ROOT, 'support', 'SKILL.md');
    expect(fs.existsSync(md)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/support-skill.test.ts`
Expected: FAIL — `support/SKILL.md.tmpl` does not exist.

- [ ] **Step 3: Write the skill template**

Create `support/SKILL.md.tmpl` with exactly this content:

````markdown
---
name: support
preamble-tier: 2
version: 1.0.0
description: |
  App support agent. Triage an incoming support ticket, investigate the root
  cause, and draft a customer reply grounded in evidence — never fabricated.
  Batch mode (--queue) triages a queue of open tickets; rollup mode (--rollup)
  summarizes themes, sentiment trend, and contract/churn risk for Product/Eng.
  Vendor-neutral: paste a ticket, pass a file/URL, or configure support_fetch /
  support_list in CLAUDE.md. Replies are drafted for your review, never sent.
  Use when asked to "handle this support ticket", "triage this", "draft a reply
  to this customer", "support rollup", or "what are customers complaining about".
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
  - WebSearch
  - Skill
triggers:
  - handle this support ticket
  - triage this ticket
  - draft a reply to this customer
  - support rollup
  - what are customers complaining about
---

{{PREAMBLE}}

# Support Agent

You triage app support requests, draft grounded customer replies, and roll up
ticket signal for Product and Engineering. You orchestrate existing gstack
skills — you do not reimplement debugging or redaction.

## Modes

Decide the mode from the invocation:
1. **Per-ticket (default)** — a single ticket was pasted, or a file/URL/id given.
2. **`--queue`** — batch-triage every open ticket from the configured queue.
3. **`--rollup [--since <window>]`** — summarize the support log (default 30d).

## Canonical ticket contract

A ticket you ingest has this shape (all but `id`/`body` optional; tolerate
missing fields, and map pasted free text onto `subject`/`body`):

```
{ "id", "subject", "body", "channel"?, "created_at"?, "customer_ref"?, "metadata"? }
```

## Intake (vendor-neutral — never hardcode a vendor)

Resolve the ticket in this order:
1. The user pasted ticket text, or gave a file path / URL → use it directly.
2. A `support_fetch` command is recorded in CLAUDE.md → run it with the id to
   fetch one ticket (it returns the contract JSON).
3. Otherwise → AskUserQuestion: paste the ticket, give a file/URL, or provide a
   fetch command. If they give a command, persist it to CLAUDE.md under a
   "Support" section so you never have to ask again.

`--queue` additionally needs a `support_list` command (returns open ids, or
`{id, subject}` objects). Apply the same read→ask→persist rule.

## Per-ticket workflow

1. Acquire the ticket (Intake).
2. **Classify** (record these — they drive the rollup):
   - `category`: bug | how-to | billing | outage | feature-request | account | other
   - `priority`: P0–P3 from impact + urgency.
   - `sentiment`: frustrated | neutral | satisfied, plus `sentiment_intensity` 1–3.
   - `contract_risk`: true/false + a short `contract_risk_reason`. Fire on
     churn/cancellation language, contract/renewal mentions, escalation threats
     ("talking to my manager", "considering alternatives"), or a repeat of an
     already-logged unresolved theme (check `gstack-support-log read`).
   - `theme_tags`: short normalized tags for grouping.
   - `one_line_summary`: content-light, PII-scrubbed (no names, emails, secrets).
3. **Investigate** when the ticket reports something broken (error, 500,
   "not working", regression): invoke the `/investigate` skill to get a root
   cause. For pure how-to / account questions, skip to drafting.
4. **Draft a reply.** Ground every claim in the investigation. NEVER fabricate a
   fix, a root cause, or a ship date. If you cannot resolve it from available
   evidence, say so in the draft and list exactly what eng input is needed.
5. **Redaction-scan the draft before showing it.** Write the draft to a temp
   file and scan the exact bytes:
   ```bash
   DRAFT=$(mktemp); cat > "$DRAFT" <<'EOF'
   <your drafted reply>
   EOF
   "${CLAUDE_SKILL_DIR}/../bin/gstack-redact" --from-file "$DRAFT"
   ```
   Resolve any HIGH finding before presenting (HIGH blocks; exit code 3).
6. **Log a redacted record** (content-light — summary + classification, never
   raw customer text):
   ```bash
   "${CLAUDE_SKILL_DIR}/../bin/gstack-support-log" append '{"ticket_ref":"...","category":"...","priority":"...","sentiment":"...","sentiment_intensity":2,"contract_risk":false,"contract_risk_reason":"","theme_tags":["..."],"one_line_summary":"...","status":"drafted"}'
   ```
   (The helper fails closed if a HIGH secret slipped into the summary/reason.)
7. **Present** the classification + the drafted reply to the user. You do NOT
   send it — sending is the user's manual step.

## Queue mode (`--queue`)

Require `support_list` (else ask the user to configure it). For each returned
id: fetch via `support_fetch`, run the per-ticket steps 2–6, and write the
drafted reply to `~/.gstack/projects/<slug>/support-drafts/<ticket_ref>.md` for
the user's review. Drafts are NEVER auto-sent. Finish with a summary table:
ticket_ref · category · priority · sentiment · contract_risk · draft path.

## Rollup mode (`--rollup [--since <window>]`)

1. Read the log: `"${CLAUDE_SKILL_DIR}/../bin/gstack-support-log" read --since <window> --json` (default 30d).
2. Aggregate: top themes (by `theme_tags`), sentiment trend, priority mix, and a
   ranked contract/churn-risk list with the recorded reasons.
3. Write a markdown digest to
   `~/.gstack/projects/<slug>/support-rollups/<date>.md`.
4. Offer (AskUserQuestion) to also open a GitHub issue for Product/Eng. If yes:
   write the issue body to a temp file, scan it with `gstack-redact --from-file`
   (resolve HIGH before sending), then `gh issue create` with the SAME file. If
   `gh` is unavailable, keep it file-only and say so.

## Guardrails

- Replies are drafted, NEVER sent automatically.
- Never fabricate a fix, root cause, or date. Grounded or flagged-as-unknown.
- Never persist or post raw customer text — only the content-light, redacted
  summary. Every external/persisted string is redaction-scanned at the sink.
````

- [ ] **Step 4: Generate the SKILL.md and verify freshness**

Run:
```
bun run gen:skill-docs --host claude
bun run gen:skill-docs --dry-run --host claude
```
Expected: first command writes `support/SKILL.md`; dry-run reports `FRESH:` for it (no `STALE:`).

- [ ] **Step 5: Add README skill-list + CLAUDE.md routing**

In `README.md`, add a row to the skills table (find the table that lists `/qa`, `/review`, `/ship`, etc.) in the same format:
```
| `/support` | **Support Agent** — triage a ticket, investigate, draft a grounded customer reply, log it. `--queue` batch-triages open tickets; `--rollup` summarizes themes, sentiment, and contract/churn risk for Product/Eng. Vendor-neutral, drafts-only. |
```
In `CLAUDE.md`, under "## Skill routing", add:
```
- Support ticket / customer reply / triage → invoke /support
```

- [ ] **Step 6: Run tests to verify pass**

Run: `bun test test/support-skill.test.ts`
Expected: PASS (all cases).

- [ ] **Step 7: Commit**

```bash
git add support/SKILL.md.tmpl support/SKILL.md test/support-skill.test.ts README.md CLAUDE.md
git commit -m "feat(support): add /support skill (per-ticket, --queue, --rollup)"
```

---

### Task 3: Full free suite, regenerate all hosts, push

**Files:** none (integration + git).

- [ ] **Step 1: Regenerate all host docs (proves the skill generates everywhere + cursor command)**

Run: `bun run gen:skill-docs --host all`
Expected: completes; `support` appears in the per-host output. (`.cursor`/`.agents`/etc are gitignored.)

- [ ] **Step 2: Confirm the cursor command is produced**

Run: `bun run gen:cursor-commands --out /tmp/gstack-support-smoke && ls /tmp/gstack-support-smoke/.cursor/commands/gstack-support.md`
Expected: `gstack-support.md` exists.

- [ ] **Step 3: Run the free suite**

Run: `bun test`
Expected: the new `support-log` and `support-skill` files pass; no NEW failures vs the known pre-existing `browse/test/sidebar-ux.test.ts` baseline. If a failure appears in a file you touched, fix it before proceeding.

- [ ] **Step 4: Skill health dashboard**

Run: `bun run skill:check`
Expected: `support` present, no errors.

- [ ] **Step 5: Push the branch**

```bash
git push -u fork feat/support-agent
```
Report the branch URL: `https://github.com/1waterrj/gstack/tree/feat/support-agent`. Do not merge or open a PR unless the user asks.

---

## Self-Review

- **Spec coverage:** Task 1 = support log + redaction-on-write (spec "Support log", "Outputs & safety"); Task 2 = the skill with all three modes, intake contract, classification, guardrails, reuse of /investigate + redaction (spec "Skill shape", "Modes", "Intake", "Canonical ticket contract", "Classification"); Task 3 = generation/cursor-command/test integration + push. Non-goals (auto-send, vendor adapter) are explicitly preserved by the drafts-only guardrail and configurable intake. All spec sections map to a task.
- **Placeholder scan:** no TBD/TODO. Two deliberate "confirm when implementing" notes (the `flagValue` boolean-flag contract in Task 1 Step 3; the HIGH-secret fixture in Task 1 Step 4) are read-before-edit verifications against real library behavior, each with a concrete fallback — not missing logic.
- **Type consistency:** the record schema is identical across the helper (`REQUIRED` + written fields), the Task 1 tests, and the SKILL template's `append` call. The CLI verbs (`append`, `read`) and flags (`--since`, `--json`) match between helper, tests, and the template's rollup step. Paths (`~/.gstack/projects/<slug>/support.jsonl`, `support-drafts/`, `support-rollups/`) are consistent throughout.
