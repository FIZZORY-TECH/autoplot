import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(__dirname, '..', '..');
const START_MARKER = '<!-- doctest:cmd:start -->';
const END_MARKER = '<!-- doctest:cmd:end -->';

function extractCommandsBlock(md: string): string {
  const start = md.indexOf(START_MARKER);
  const end = md.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`CLAUDE.md is missing ${START_MARKER} / ${END_MARKER} markers`);
  }
  return md.slice(start, end);
}

function extractNpmScripts(block: string): string[] {
  const scripts: string[] = [];
  for (const line of block.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|');
    if (cells.length < 2) continue;
    const codeSpans = cells[1].match(/`([^`]+)`/g);
    if (!codeSpans) continue;
    for (const span of codeSpans) {
      const m = span.slice(1, -1).trim().match(/^npm\s+run\s+([A-Za-z0-9:_-]+)/);
      if (m) scripts.push(m[1]);
    }
  }
  return scripts;
}

describe('CLAUDE.md doctest: npm run commands resolve to package.json scripts', () => {
  const md = readFileSync(resolve(repoRoot, 'CLAUDE.md'), 'utf8');
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
  const definedScripts = new Set<string>(Object.keys(pkg.scripts ?? {}));

  const block = extractCommandsBlock(md);
  const referenced = extractNpmScripts(block);

  it('finds at least one npm run reference in the commands table', () => {
    expect(referenced.length).toBeGreaterThan(0);
  });

  it.each(referenced)('package.json defines script "%s"', (script) => {
    expect(
      definedScripts.has(script),
      `CLAUDE.md references \`npm run ${script}\` but package.json has no such script. ` +
        `Defined scripts: ${[...definedScripts].join(', ')}`,
    ).toBe(true);
  });
});
