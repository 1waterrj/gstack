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
      one_line_summary: 'user pasted their key AKIA1234567890ABCDEF in the ticket',
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

  test('read --json on an empty/fresh log returns [] and exits 0 (rollup path)', () => {
    const r = run(['read', '--json'], home);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.toString())).toEqual([]);
  });
});
