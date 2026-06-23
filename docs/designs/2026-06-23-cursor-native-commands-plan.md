# Cursor-Native Slash Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every gstack skill invocable as a native Cursor slash command by emitting `.cursor/commands/*.md` (full-inline bodies) plus a `.cursor/rules/gstack.mdc` routing rule, driven by `./setup --host cursor`.

**Architecture:** Additive on top of gstack's declarative host system. Reuse the existing per-host renderer (`processTemplate(tmpl, 'cursor')` already returns the fully path-rewritten, frontmatter-transformed cursor body) to write one command file per skill. A new `scripts/gen-cursor-commands.ts` orchestrates this; `hosts/cursor.ts` gains an optional `cursorCommands` capability; `setup` learns the `cursor` host.

**Tech Stack:** TypeScript, Bun, bash (`setup`), `bun:test`.

## Global Constraints

- **Additive / upstream-mergeable.** New optional `HostConfig` field, new script, new `setup` branch. No edits to other host configs or the core generation loop's behavior for non-cursor hosts.
- **Single source / no drift.** Command bodies MUST come from `processTemplate(tmpl, 'cursor').content` — never hand-authored or copied.
- **Command name = `externalSkillName(skillDir, frontmatterName)`** which already yields `gstack-<name>` (root skill → `gstack`). No separate prefix field.
- **No `.claude/skills` leakage** in any generated command body (cursor `pathRewrites` handle this; tests assert it).
- **`/codex` skill excluded** — already in cursor `generation.skipSkills`. The enumerator reuses the same include/skip filter as the main loop.
- **`.cursor/` stays gitignored** (already present in `.gitignore`). Generated output is never committed.
- **Output root is parameterized** via `--out <dir>` (default `$HOME`): commands → `<out>/.cursor/commands/`, rule → `<out>/.cursor/rules/gstack.mdc`. Tests pass a temp dir; setup passes `$HOME` (global) or the repo root (`--team`).

---

### Task 1: Add `cursorCommands` capability to the host-config system

**Files:**
- Modify: `scripts/host-config.ts` (interface + validator)
- Modify: `hosts/cursor.ts` (set the field)
- Test: `test/host-config.test.ts`

**Interfaces:**
- Produces: `HostConfig.cursorCommands?: { enabled: boolean; emitRoutingRule: boolean }`

- [ ] **Step 1: Write the failing test**

Add to `test/host-config.test.ts`:

```typescript
import cursor from '../hosts/cursor';
import { validateHostConfig } from '../scripts/host-config';

describe('cursor cursorCommands capability', () => {
  test('cursor host enables native command generation', () => {
    expect(cursor.cursorCommands?.enabled).toBe(true);
    expect(cursor.cursorCommands?.emitRoutingRule).toBe(true);
  });

  test('cursor config still validates', () => {
    expect(validateHostConfig(cursor)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/host-config.test.ts -t "cursorCommands"`
Expected: FAIL — `cursor.cursorCommands` is `undefined`.

- [ ] **Step 3: Add the optional field to the interface**

In `scripts/host-config.ts`, inside the `HostConfig` interface (e.g. just after the `adapter?: string;` field), add:

```typescript
  /**
   * Cursor-only: emit native .cursor/commands/*.md slash commands (and an
   * optional .cursor/rules routing rule) in addition to the generated skill
   * docs. No other host sets this; consumed by scripts/gen-cursor-commands.ts.
   */
  cursorCommands?: {
    /** Emit native .cursor/commands/*.md files. */
    enabled: boolean;
    /** Also emit .cursor/rules/gstack.mdc routing rule. */
    emitRoutingRule: boolean;
  };
```

(No validator clause is required — the field is optional and self-contained. Leave `validateHostConfig` unchanged.)

- [ ] **Step 4: Set the field on the cursor host**

In `hosts/cursor.ts`, add this property to the `cursor` object (e.g. after `learningsMode: 'basic',`):

```typescript
  cursorCommands: {
    enabled: true,
    emitRoutingRule: true,
  },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/host-config.test.ts`
Expected: PASS (all, including the two new cases).

- [ ] **Step 6: Commit**

```bash
git add scripts/host-config.ts hosts/cursor.ts test/host-config.test.ts
git commit -m "feat(cursor): add cursorCommands capability to host config"
```

---

### Task 2: Export the renderer helpers from `gen-skill-docs.ts`

**Files:**
- Modify: `scripts/gen-skill-docs.ts` (add `export` to two functions)
- Test: `test/gen-cursor-commands.test.ts` (new file — first cases)

**Interfaces:**
- Produces: `export function processTemplate(tmplPath: string, host?: Host): { outputPath: string; content: string; symlinkLoop?: boolean; catalogParts?: CatalogParts | null }`
- Produces: `export function externalSkillName(skillDir: string, frontmatterName?: string): string`

- [ ] **Step 1: Write the failing test**

Create `test/gen-cursor-commands.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import * as path from 'path';
import { processTemplate, externalSkillName } from '../scripts/gen-skill-docs';

const ROOT = path.resolve(import.meta.dir, '..');

describe('cursor renderer reuse', () => {
  test('processTemplate renders a cursor body with no .claude/skills leakage', () => {
    const { content } = processTemplate(path.join(ROOT, 'qa', 'SKILL.md.tmpl'), 'cursor');
    expect(content).not.toContain('.claude/skills');
    expect(content).toContain('.cursor/skills');
  });

  test('externalSkillName yields gstack-prefixed names', () => {
    expect(externalSkillName('qa', 'qa')).toBe('gstack-qa');
    expect(externalSkillName('', '')).toBe('gstack');
    expect(externalSkillName('gstack-upgrade', 'gstack-upgrade')).toBe('gstack-upgrade');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/gen-cursor-commands.test.ts -t "cursor renderer reuse"`
Expected: FAIL — `processTemplate`/`externalSkillName` are not exported (import is `undefined`).

- [ ] **Step 3: Add `export` to both functions**

In `scripts/gen-skill-docs.ts`:
- Change `function externalSkillName(` (line ~183) to `export function externalSkillName(`.
- Change `function processTemplate(` (line ~798) to `export function processTemplate(`.

No body changes. These are pure functions already used internally; exporting is non-breaking.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/gen-cursor-commands.test.ts -t "cursor renderer reuse"`
Expected: PASS.

- [ ] **Step 5: Verify nothing else regressed**

Run: `bun test test/gen-skill-docs.test.ts`
Expected: PASS (exporting changes no behavior).

- [ ] **Step 6: Commit**

```bash
git add scripts/gen-skill-docs.ts test/gen-cursor-commands.test.ts
git commit -m "refactor(gen): export processTemplate + externalSkillName for reuse"
```

---

### Task 3: Build the command generator `scripts/gen-cursor-commands.ts`

**Files:**
- Create: `scripts/gen-cursor-commands.ts`
- Modify: `package.json` (add `gen:cursor-commands` script)
- Test: `test/gen-cursor-commands.test.ts` (add generator cases)

**Interfaces:**
- Consumes: `processTemplate`, `externalSkillName` (Task 2); `getHostConfig` from `../hosts/index`; `discoverTemplates` from `./discover-skills`.
- Produces: `export function generateCursorCommands(opts: { outRoot: string }): { commandFiles: string[]; rulePath: string | null }`

- [ ] **Step 1: Write the failing test**

Add to `test/gen-cursor-commands.test.ts`:

```typescript
import * as fs from 'fs';
import * as os from 'os';
import { generateCursorCommands } from '../scripts/gen-cursor-commands';
import { discoverTemplates } from '../scripts/discover-skills';
import cursor from '../hosts/cursor';

describe('generateCursorCommands', () => {
  let outRoot: string;
  let result: { commandFiles: string[]; rulePath: string | null };

  beforeAll(() => {
    outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-cursor-'));
    result = generateCursorCommands({ outRoot });
  });

  test('emits one command file per generated cursor skill', () => {
    const skills = discoverTemplates(ROOT)
      .map(t => path.basename(path.dirname(t.tmpl)) === '..' ? '' : path.dirname(t.tmpl))
      .map(d => (d === '.' ? '' : d));
    const expectedCount = discoverTemplates(ROOT).filter(t => {
      const dir = path.basename(path.dirname(path.join(ROOT, t.tmpl)));
      return !(cursor.generation.skipSkills ?? []).includes(dir);
    }).length;
    expect(result.commandFiles.length).toBe(expectedCount);
  });

  test('command files live under .cursor/commands and are gstack-prefixed', () => {
    for (const f of result.commandFiles) {
      expect(f).toContain(path.join('.cursor', 'commands'));
      expect(path.basename(f).startsWith('gstack')).toBe(true);
      expect(f.endsWith('.md')).toBe(true);
    }
  });

  test('no .claude/skills leakage in any command body', () => {
    for (const f of result.commandFiles) {
      expect(fs.readFileSync(f, 'utf-8')).not.toContain('.claude/skills');
    }
  });

  test('excludes the codex skill', () => {
    expect(result.commandFiles.some(f => path.basename(f) === 'gstack-codex.md')).toBe(false);
  });

  test('command body equals the generated cursor SKILL.md body (no drift)', () => {
    const qaFile = result.commandFiles.find(f => path.basename(f) === 'gstack-qa.md')!;
    const body = fs.readFileSync(qaFile, 'utf-8');
    const { content } = processTemplate(path.join(ROOT, 'qa', 'SKILL.md.tmpl'), 'cursor');
    expect(body).toContain(content);
  });

  test('emits a valid .cursor/rules/gstack.mdc routing rule', () => {
    expect(result.rulePath).toBeTruthy();
    const mdc = fs.readFileSync(result.rulePath!, 'utf-8');
    expect(mdc.startsWith('---\n')).toBe(true);
    expect(mdc).toContain('description:');
    expect(mdc).toContain('/gstack-');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/gen-cursor-commands.test.ts -t "generateCursorCommands"`
Expected: FAIL — module `../scripts/gen-cursor-commands` does not exist.

- [ ] **Step 3: Write the generator**

Create `scripts/gen-cursor-commands.ts`:

```typescript
#!/usr/bin/env bun
/**
 * Generate native Cursor slash commands from gstack skills.
 *
 * Cursor reads slash commands from .cursor/commands/*.md (filename = command
 * name, file body = prompt). gstack skills don't live there, so this script
 * writes one command file per skill, with the body taken verbatim from the
 * cursor-host SKILL.md renderer (processTemplate) so there is no drift.
 *
 * Also emits a .cursor/rules/gstack.mdc routing rule when the cursor host
 * config sets cursorCommands.emitRoutingRule.
 *
 *   bun run scripts/gen-cursor-commands.ts [--out <dir>]
 *
 * --out defaults to $HOME. Commands -> <out>/.cursor/commands/,
 * rule -> <out>/.cursor/rules/gstack.mdc.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { discoverTemplates } from './discover-skills';
import { processTemplate, externalSkillName } from './gen-skill-docs';
import { getHostConfig } from '../hosts/index';

const ROOT = path.resolve(import.meta.dir, '..');

/** Curated routing table. command names match externalSkillName output. */
const ROUTING: Array<{ when: string; command: string }> = [
  { when: 'Product ideas / brainstorming', command: '/gstack-office-hours' },
  { when: 'Strategy / scope', command: '/gstack-plan-ceo-review' },
  { when: 'Architecture', command: '/gstack-plan-eng-review' },
  { when: 'Design system or plan-level design review', command: '/gstack-design-consultation' },
  { when: 'Bugs / errors / unexpected behavior', command: '/gstack-investigate' },
  { when: 'QA / testing live site behavior', command: '/gstack-qa or /gstack-qa-only' },
  { when: 'Code review / diff check', command: '/gstack-review' },
  { when: 'Visual polish', command: '/gstack-design-review' },
  { when: 'Ship / deploy / open a PR', command: '/gstack-ship or /gstack-land-and-deploy' },
  { when: 'Security audit', command: '/gstack-cso' },
  { when: 'Full review pipeline', command: '/gstack-autoplan' },
];

function extractFrontmatterName(tmplContent: string): string | undefined {
  const m = tmplContent.match(/^---\n[\s\S]*?\nname:\s*(.+)$/m);
  return m ? m[1].trim() : undefined;
}

function buildRoutingRule(): string {
  const lines = ROUTING.map(r => `- ${r.when} → ${r.command}`).join('\n');
  return `---
description: gstack skill routing — pick the right /gstack-* command
alwaysApply: false
---
When the user's request matches a gstack workflow, invoke the matching command:
${lines}

Each /gstack-* command contains the full skill instructions. Prefer them over
ad-hoc implementations for the workflows above.
`;
}

export function generateCursorCommands(opts: { outRoot: string }): {
  commandFiles: string[];
  rulePath: string | null;
} {
  const config = getHostConfig('cursor');
  if (!config.cursorCommands?.enabled) return { commandFiles: [], rulePath: null };

  const commandsDir = path.join(opts.outRoot, '.cursor', 'commands');
  fs.mkdirSync(commandsDir, { recursive: true });

  const skip = new Set(config.generation.skipSkills ?? []);
  const include = config.generation.includeSkills?.length
    ? new Set(config.generation.includeSkills)
    : null;

  const commandFiles: string[] = [];

  for (const { tmpl } of discoverTemplates(ROOT)) {
    const tmplPath = path.join(ROOT, tmpl);
    const dir = path.basename(path.dirname(tmplPath)); // 'qa', or repo name for root
    const isRoot = path.dirname(tmplPath) === ROOT;
    const skillDir = isRoot ? '' : dir;

    if (include && !isRoot && !include.has(dir)) continue;
    if (!isRoot && skip.has(dir)) continue;

    const tmplContent = fs.readFileSync(tmplPath, 'utf-8');
    const frontName = extractFrontmatterName(tmplContent);
    const commandName = externalSkillName(skillDir, frontName); // gstack-qa, gstack, ...

    const { content, symlinkLoop } = processTemplate(tmplPath, 'cursor');
    if (symlinkLoop) continue;

    const header = `# /${commandName}\n\n` +
      `<!-- AUTO-GENERATED Cursor command from ${tmpl} — regenerate: bun run gen:cursor-commands -->\n\n`;
    const outPath = path.join(commandsDir, `${commandName}.md`);
    fs.writeFileSync(outPath, header + content);
    commandFiles.push(outPath);
  }

  let rulePath: string | null = null;
  if (config.cursorCommands.emitRoutingRule) {
    const rulesDir = path.join(opts.outRoot, '.cursor', 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    rulePath = path.join(rulesDir, 'gstack.mdc');
    fs.writeFileSync(rulePath, buildRoutingRule());
  }

  return { commandFiles, rulePath };
}

// CLI entrypoint
if (import.meta.main) {
  const outArg = process.argv.find(a => a.startsWith('--out'));
  const outRoot = outArg
    ? (outArg.includes('=') ? outArg.split('=')[1] : process.argv[process.argv.indexOf(outArg) + 1])
    : (process.env.HOME || os.homedir());
  const { commandFiles, rulePath } = generateCursorCommands({ outRoot });
  for (const f of commandFiles) console.log(`GENERATED: ${f}`);
  if (rulePath) console.log(`GENERATED: ${rulePath}`);
  console.log(`\n${commandFiles.length} Cursor command(s) written to ${path.join(outRoot, '.cursor', 'commands')}`);
}
```

- [ ] **Step 4: Add the package script**

In `package.json`, in `"scripts"`, after the `gen:skill-docs:user` line, add:

```json
    "gen:cursor-commands": "bun run scripts/gen-cursor-commands.ts",
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/gen-cursor-commands.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Smoke-run the CLI to a temp dir**

Run: `bun run gen:cursor-commands --out /tmp/gstack-cursor-smoke && ls /tmp/gstack-cursor-smoke/.cursor/commands | head`
Expected: a list of `gstack-*.md` files and a non-zero count printed; `/tmp/gstack-cursor-smoke/.cursor/rules/gstack.mdc` exists.

- [ ] **Step 7: Commit**

```bash
git add scripts/gen-cursor-commands.ts package.json test/gen-cursor-commands.test.ts
git commit -m "feat(cursor): generate native .cursor/commands + routing rule"
```

---

### Task 4: Wire the cursor host into `setup`

**Files:**
- Modify: `setup` (host allowlist + a `link_cursor_commands` step + call site)
- Test: `test/setup-cursor.test.ts` (new — static-grep invariants, modeled on `test/setup-windows-fallback.test.ts`)

**Interfaces:**
- Consumes: `bun run gen:cursor-commands` (Task 3), `bun run gen:skill-docs --host cursor` (existing).

- [ ] **Step 1: Write the failing test**

Create `test/setup-cursor.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const setup = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');

describe('setup cursor wiring', () => {
  test('cursor is an accepted --host value', () => {
    // The host validation case line includes cursor.
    expect(setup).toMatch(/claude\|codex\|kiro\|factory\|opencode\|cursor\|auto|cursor\|auto/);
    expect(setup).toContain('cursor');
  });

  test('setup invokes the cursor command generator', () => {
    expect(setup).toContain('gen:cursor-commands');
    expect(setup).toContain('gen:skill-docs --host cursor');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/setup-cursor.test.ts`
Expected: FAIL — `setup` contains neither `gen:cursor-commands` nor `--host cursor`.

- [ ] **Step 3: Add `cursor` to the host allowlist**

In `setup`, line ~104, change:

```bash
  claude|codex|kiro|factory|opencode|auto) ;;
```
to:
```bash
  claude|codex|kiro|factory|opencode|cursor|auto) ;;
```

And update the two `Unknown --host value` messages (lines ~88 and ~139) to include `cursor` in their expected-values text.

- [ ] **Step 4: Add the cursor install function**

In `setup`, near `link_opencode_skill_dirs` (~line 943), add a sibling function:

```bash
link_cursor_commands() {
  local gstack_dir="$1"
  local out_root="$2"   # $HOME for global, repo root for --team

  echo "  Generating .cursor/ skill docs + native commands..."
  ( cd "$gstack_dir" && bun run gen:skill-docs --host cursor ) \
    || { echo "  warning: 'gen:skill-docs --host cursor' failed — run it manually" >&2; return 1; }
  ( cd "$gstack_dir" && bun run gen:cursor-commands --out "$out_root" ) \
    || { echo "  warning: 'gen:cursor-commands' failed — run it manually" >&2; return 1; }

  echo "  Cursor slash commands installed to $out_root/.cursor/commands/"
  echo "  Open Cursor, type / in chat, and pick a /gstack-* command."
}
```

- [ ] **Step 5: Call it from the cursor host path**

In `setup`'s host-dispatch region (the `elif [ "$HOST" = "opencode" ]` chain near lines 213–221), add a cursor branch that calls the function with the global root by default and the repo root under `--team`. Use the same `$TEAM`/team-mode variable the opencode branch consults (grep `setup` for the team flag name first; it is set from the `--team` arg parsed near line 88). Concretely:

```bash
elif [ "$HOST" = "cursor" ]; then
  if [ "${TEAM:-0}" = "1" ]; then
    link_cursor_commands "$SOURCE_GSTACK_DIR" "$(pwd)"
  else
    link_cursor_commands "$SOURCE_GSTACK_DIR" "$HOME"
  fi
```

(Confirm the exact variable names `SOURCE_GSTACK_DIR` and the team flag by grepping `setup` during implementation; reuse whatever the opencode branch uses rather than inventing names.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test test/setup-cursor.test.ts`
Expected: PASS.

- [ ] **Step 7: Lint the shell script**

Run: `bash -n setup`
Expected: no syntax errors (exit 0).

- [ ] **Step 8: Commit**

```bash
git add setup test/setup-cursor.test.ts
git commit -m "feat(cursor): wire ./setup --host cursor to install native commands"
```

---

### Task 5: Docs — README install row + ADDING_A_HOST note

**Files:**
- Modify: `README.md` (Cursor host row)
- Modify: `docs/ADDING_A_HOST.md` (mention `cursorCommands`)

- [ ] **Step 1: Update the README Cursor row**

In `README.md`, find the host table row (line ~118):

```
| Cursor | `--host cursor` | `~/.cursor/skills/gstack-*/` |
```
Replace the description so it reflects native commands. Change/extend the row to:

```
| Cursor | `--host cursor` | `~/.cursor/commands/gstack-*.md` (native slash commands) + `~/.cursor/skills/gstack/` |
```

And add one sentence after the table: "On Cursor, gstack installs as native slash commands — type `/` in chat and pick a `/gstack-*` command. A `.cursor/rules/gstack.mdc` routing rule helps Cursor pick the right one."

- [ ] **Step 2: Note the capability in ADDING_A_HOST.md**

In `docs/ADDING_A_HOST.md`, under the config field reference table, add a row:

```
| `cursorCommands` | Cursor-only: also emit native `.cursor/commands/*.md` + a `.cursor/rules` routing rule (see `scripts/gen-cursor-commands.ts`) |
```

- [ ] **Step 3: Verify generated docs are still fresh**

Run: `bun run gen:skill-docs --dry-run --host cursor`
Expected: no `STALE:` lines (we changed only README/docs, not templates). If anything is stale, run `bun run gen:skill-docs --host cursor` and stage the result.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/ADDING_A_HOST.md
git commit -m "docs(cursor): document native slash-command install"
```

---

### Task 6: Full test pass, fork, push

**Files:** none (integration + git).

- [ ] **Step 1: Run the free test suite**

Run: `bun test`
Expected: PASS. Pay attention to `host-config.test.ts`, `gen-cursor-commands.test.ts`, `setup-cursor.test.ts`, and the parameterized host smoke tests.

- [ ] **Step 2: Run the skill health dashboard**

Run: `bun run skill:check`
Expected: cursor host present, no errors.

- [ ] **Step 3: Create the fork on 1waterrj**

```bash
gh repo fork garrytan/gstack --org-or-user 1waterrj --remote=false --clone=false
```
(If `gh` is active as `1waterrj`, `gh repo fork garrytan/gstack --clone=false` is sufficient.) Then add the fork as a remote:

```bash
git remote add fork https://github.com/1waterrj/gstack.git
```

- [ ] **Step 4: Push the branch to the fork**

```bash
git push -u fork feat/cursor-native-commands
```

- [ ] **Step 5: Report the branch URL**

Print the compare/PR URL: `https://github.com/1waterrj/gstack/tree/feat/cursor-native-commands`. Do NOT open a PR against `garrytan/gstack` unless the user asks.

---

## Verification (real Cursor — manual, after push)

These confirm the runtime behavior tests can't:

1. `./setup --host cursor` on a machine with Cursor installed.
2. Confirm `~/.cursor/commands/` is populated with `gstack-*.md` and `~/.cursor/rules/gstack.mdc` exists.
3. Open Cursor, type `/` in chat, confirm `/gstack-*` commands appear in the dropdown.
4. Run one (e.g. `/gstack-review`) and confirm the full skill prompt loads.
5. **Command-size cap check (the one open risk):** confirm the largest command (`gstack-ship.md` / `gstack-office-hours.md`, ~25–35K tokens) loads without truncation. If Cursor rejects oversized command files, fall back to a thin-stub body for over-cap skills only (hybrid) — add as a follow-up task; do not block the rest.

## Self-Review

- **Spec coverage:** Task 1 = `cursorCommands` field; Task 2 = renderer reuse (single-source/no-drift); Task 3 = command generator + full-inline bodies + routing rule; Task 4 = `setup` wiring (global default, `--team` project); Task 5 = docs; Task 6 = tests + fork + push. Distribution (gitignored, generated) is honored — nothing writes into the repo's `.cursor/`. All spec sections map to a task.
- **Placeholder scan:** no TBD/TODO; all code shown. The one "confirm exact variable names" note (Task 4 Step 5) is a deliberate read-before-edit instruction against the live `setup` script, not a placeholder for missing logic.
- **Type consistency:** `generateCursorCommands({ outRoot })` returns `{ commandFiles, rulePath }` — used identically in tests and CLI. `externalSkillName`/`processTemplate` signatures match `gen-skill-docs.ts`. Command name derivation is consistent (`externalSkillName(skillDir, frontName)`) across generator and routing table.
