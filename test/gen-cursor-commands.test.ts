import { describe, test, expect, beforeAll } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { processTemplate, externalSkillName } from '../scripts/gen-skill-docs';
import { generateCursorCommands } from '../scripts/gen-cursor-commands';
import { discoverTemplates } from '../scripts/discover-skills';
import cursor from '../hosts/cursor';

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

describe('generateCursorCommands', () => {
  let outRoot: string;
  let result: { commandFiles: string[]; rulePath: string | null };

  beforeAll(() => {
    outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-cursor-'));
    result = generateCursorCommands({ outRoot });
  });

  test('emits one command file per generated cursor skill', () => {
    const skip = cursor.generation.skipSkills ?? [];
    const expectedCount = discoverTemplates(ROOT).filter(({ tmpl }) => {
      const tmplPath = path.join(ROOT, tmpl);
      const isRoot = path.dirname(tmplPath) === ROOT;
      const dir = path.basename(path.dirname(tmplPath));
      return isRoot || !skip.includes(dir);
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
    expect(qaFile).toBeTruthy();
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
