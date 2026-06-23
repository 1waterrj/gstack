# Cursor-Native Slash Commands for gstack

**Status:** Approved (design) — 2026-06-23
**Author:** Jordan Waters (1waterrj fork)
**Scope:** Make every gstack skill invocable as a native Cursor slash command.

## Problem

gstack already ships a Cursor host (`hosts/cursor.ts`, `./setup --host cursor`). It
installs generated skills into `~/.cursor/skills/gstack/`. But **Cursor has no native
"skills" concept** — it does not auto-discover that directory. Cursor's actual extension
points are:

- `.cursor/commands/*.md` — native slash commands. Filename becomes the command name;
  the **entire file content becomes the prompt** when invoked. Project dir
  (`<repo>/.cursor/commands/`) and global dir (`~/.cursor/commands/`) are both scanned.
  (Cursor 1.6+.)
- `.cursor/rules/*.mdc` — context rules with frontmatter (`description`, `globs`,
  `alwaysApply`).

So today a Cursor user must manually tell the agent "go read that SKILL.md." The goal is
to make `/gstack-qa`, `/gstack-review`, `/gstack-ship`, etc. work as first-class Cursor
slash commands.

## Goals

- Every skill the Cursor host generates (all discovered skills minus
  `generation.skipSkills`) becomes a native Cursor slash command.
- Self-contained command bodies (full skill instructions inlined), generated from
  gstack's single source so there is **no manual duplication and no drift**.
- A routing rule (`.cursor/rules/gstack.mdc`) so Cursor proactively reaches for the right
  command.
- Stay **additive and upstream-mergeable** — no rewrite of the generator or setup engine.
- Driven by the existing `./setup --host cursor` flow; `.cursor/` stays gitignored
  (matches gstack's generate-on-setup philosophy).

## Non-Goals

- Not changing how other hosts (Claude, Codex, etc.) work.
- Not committing generated `.cursor/` output into the repo (it remains generated).
- Not porting the `/codex` skill (already excluded via `generation.skipSkills` for
  Cursor — it is Claude-CLI-specific).

## Design

### 1. Extend `hosts/cursor.ts` (additive)

Add an optional capability block consumed only by the new command generator. Because it
is a new optional field, all existing tooling and other host configs are unaffected.

```ts
// New optional fields on the cursor HostConfig (and the HostConfig interface):
cursorCommands?: {
  /** Emit native .cursor/commands/*.md files. */
  enabled: boolean;
  /** Command-name prefix. 'gstack-' → /gstack-qa. */
  prefix: string;            // default 'gstack-'
  /** Also emit .cursor/rules/gstack.mdc routing rule. */
  emitRoutingRule: boolean;  // default true
};
```

`scripts/host-config.ts`'s `HostConfig` interface gains the optional field + a validator
clause (prefix matches `^[a-z0-9-]*$`). No other host sets it, so behavior elsewhere is
unchanged.

### 2. New generator: `scripts/gen-cursor-commands.ts`

Runs **after** the normal per-host generation for cursor. Pipeline:

1. Resolve the cursor `HostConfig`. If `cursorCommands?.enabled` is false/absent, no-op.
2. Enumerate the skills the cursor host generates (reuse `discoverTemplates` +
   `generation.skipSkills` / `includeSkills` — identical logic to `gen-skill-docs.ts`,
   imported, not duplicated).
3. For each skill, obtain the **already-generated, path-rewritten** SKILL.md content for
   the cursor host (the same content `gen-skill-docs.ts` produces — reuse its rendering
   path so the command body is byte-identical to the installed skill).
4. Write one command file per skill:
   - Path: `<cursorCommandsRoot>/<prefix><skill-name>.md`
     (global: `~/.cursor/commands/`; project: `<repo>/.cursor/commands/` under `--team`).
   - Body: a short generated header (command name + one-line description pulled from the
     skill frontmatter `description`) followed by the full skill instructions inlined.
5. If `emitRoutingRule`, write `.cursor/rules/gstack.mdc` from a template that mirrors
   gstack's CLAUDE.md "Skill routing" table, rewritten to reference `/gstack-*` commands.
   Frontmatter: `description: gstack skill routing`, `alwaysApply: false` (Cursor loads it
   when relevant rather than on every turn).

The generator is invoked by a new `package.json` script
(`gen:cursor-commands`) and by `setup` when host=cursor.

### 3. Wire into `setup`

In the cursor branch of `setup`, after the existing skill-doc generation + symlink step,
call the new generator (global target by default, project target under `--team`). The
existing `_link_or_copy` Windows-safe helper is not needed here because commands are
written files, not symlinks; but the skill-asset symlinks (for `references/`,
`checklist.md`, etc. that skills read on demand) remain as they are today so on-demand
reference reads still resolve.

### 4. Command body format

Each `~/.cursor/commands/gstack-<name>.md`:

```md
# /gstack-<name> — <description from frontmatter>

<full generated cursor SKILL.md body, path-rewritten to ~/.cursor/...>
```

No YAML frontmatter is required by Cursor for commands (filename = command name). We keep
the human-readable H1 header for clarity in Cursor's command dropdown preview.

### 5. Routing rule format

`~/.cursor/rules/gstack.mdc` (global) / `<repo>/.cursor/rules/gstack.mdc` (project):

```mdc
---
description: gstack skill routing — pick the right /gstack-* command
alwaysApply: false
---
When the user's request matches a gstack workflow, invoke the matching command:
- Product ideas / brainstorming → /gstack-office-hours
- Strategy / scope → /gstack-plan-ceo-review
- Architecture → /gstack-plan-eng-review
- Bugs / errors → /gstack-investigate
- QA / testing site behavior → /gstack-qa or /gstack-qa-only
- Code review / diff check → /gstack-review
- Visual polish → /gstack-design-review
- Ship / deploy / PR → /gstack-ship or /gstack-land-and-deploy
...
```

Generated from a template that reads the same routing source so it stays in sync.

## Distribution / fork strategy

- Fork `garrytan/gstack` → `github.com/1waterrj/gstack` (personal/OSS account per the
  user's account split).
- Land this work on a feature branch in the fork.
- `.cursor/` stays gitignored; users get commands by running `./setup --host cursor`.

## Testing

gstack's host tests are parameterized over `ALL_HOST_CONFIGS`, so the cursor config change
is exercised automatically. New tests:

- `test/gen-cursor-commands.test.ts` (free, Tier 1):
  - One command file per generated cursor skill; count matches discovered skills minus
    `skipSkills`.
  - Command filenames are `<prefix><skill>.md`.
  - No `.claude/skills` path leakage in command bodies (all rewritten to `.cursor`).
  - `/codex` skill excluded.
  - Command body for a sampled skill equals the generated cursor SKILL.md body (the
    "single source / no drift" invariant).
  - Routing rule emitted with valid `.mdc` frontmatter when `emitRoutingRule` is true.
- `bun run skill:check` and `bun test` must pass (free, < a few seconds).

Verification beyond tests: run `./setup --host cursor`, confirm `~/.cursor/commands/`
populated, open Cursor, type `/` and confirm `/gstack-*` commands appear and one runs.

## Risks / tradeoffs

- **Large command files.** Some skills are 25–35K tokens. Cursor loads a command body
  only on invoke, and prompt caching makes the marginal cost small — same tradeoff gstack
  already accepts for SKILL.md size. Acceptable.
- **Cursor command-size limits.** Unconfirmed whether Cursor caps command file size. The
  plan includes a verification step in a real Cursor install; if a hard cap exists, the
  fallback is the thin-stub body for over-cap skills only (hybrid), recorded as a follow-up.
- **Upstream drift.** All changes are additive (new optional config field, new script, one
  setup branch addition), minimizing future merge conflicts with `garrytan/gstack`.

## Out of scope / follow-ups

- Publishing the fork's approach back upstream as a PR (could be offered later).
- Per-skill body-size hybrid fallback (only if Cursor enforces a cap).
