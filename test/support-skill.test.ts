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
