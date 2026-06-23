import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const setup = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');

describe('setup cursor wiring', () => {
  test('cursor is an accepted --host value', () => {
    expect(setup).toContain('claude|codex|kiro|factory|opencode|cursor|auto');
  });

  test('cursor has an INSTALL flag and dispatch branch', () => {
    expect(setup).toContain('INSTALL_CURSOR=0');
    expect(setup).toContain('elif [ "$HOST" = "cursor" ]; then');
  });

  test('setup invokes the cursor skill-doc + command generators', () => {
    expect(setup).toContain('gen:skill-docs --host cursor');
    expect(setup).toContain('gen:cursor-commands');
  });

  test('setup has a guarded cursor install block', () => {
    expect(setup).toContain('if [ "$INSTALL_CURSOR" -eq 1 ]; then');
    expect(setup).toContain('link_cursor_commands');
  });
});
