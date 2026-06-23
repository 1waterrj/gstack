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
import { processTemplate } from './gen-skill-docs';
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

    if (include && !isRoot && !include.has(dir)) continue;
    if (!isRoot && skip.has(dir)) continue;

    const { content, outputPath, symlinkLoop } = processTemplate(tmplPath, 'cursor');
    if (symlinkLoop) continue;

    // Derive the command name from processTemplate's own output path
    // (.cursor/skills/<name>/SKILL.md). This reuses gen-skill-docs's canonical
    // skill-naming, so the command set always matches the generated skill set.
    const commandName = path.basename(path.dirname(outputPath)); // gstack-qa, gstack, ...

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
