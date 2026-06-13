#!/usr/bin/env node
// Generates docs/reference/tauri-ipc.md from Rust #[tauri::command] fns and TS invoke() callsites.
// Pure Node (ESM, built-ins only). Regenerate via: node scripts/gen-tauri-ipc-doc.mjs

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const RUST_DIR = path.join(repoRoot, 'src-tauri', 'src', 'commands');
const RUST_EXTRA_ROOT = path.join(repoRoot, 'src-tauri', 'src');
const TS_ROOTS = [path.join(repoRoot, 'src')];
const OUT_PATH = path.join(repoRoot, 'docs', 'reference', 'tauri-ipc.md');

/** Recursively walk a directory and yield file paths matching predicate. */
async function walk(dir, predicate) {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  const subdirResults = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
        return walk(full, predicate);
      }
      return predicate(full) ? [full] : [];
    })
  );
  for (const sub of subdirResults) out.push(...sub);
  return out;
}

/** Convert absolute path to repo-relative POSIX path. */
function rel(abs) {
  return path.relative(repoRoot, abs).split(path.sep).join('/');
}

/** Compute 1-based line number for a string offset. */
function lineFor(src, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) {
    if (src.charCodeAt(i) === 10) line++;
  }
  return line;
}

/** Extract preceding `///` doc-comment block immediately above a position. */
function extractDocComment(src, attrStart) {
  const before = src.slice(0, attrStart);
  const lines = before.split('\n');
  const docs = [];
  for (let i = lines.length - 2; i >= 0; i--) {
    const t = lines[i].trim();
    if (t.startsWith('///')) {
      docs.unshift(t.replace(/^\/\/\/\s?/, ''));
    } else {
      break;
    }
  }
  return docs.join(' ').trim();
}

/** Find balanced parens starting at openIdx (which is at '('). Returns end index just after ')' or -1. */
function findMatchingParen(src, openIdx) {
  if (src[openIdx] !== '(') return -1;
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Compact a multi-line signature fragment. */
function compactSig(s) {
  return s.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim();
}

/** Parse a single Rust file for #[tauri::command] functions. */
function parseRustFile(src) {
  const out = [];
  const attrRe = /#\[tauri::command(?:\([^)]*\))?\]/g;
  let m;
  while ((m = attrRe.exec(src)) !== null) {
    const attrStart = m.index;
    const afterAttr = m.index + m[0].length;
    // Locate the `fn NAME(` after the attribute.
    const fnRe = /\bfn\s+(\w+)\s*\(/g;
    fnRe.lastIndex = afterAttr;
    const fm = fnRe.exec(src);
    if (!fm) continue;
    const fnName = fm[1];
    const parenOpen = fm.index + fm[0].length - 1;
    const parenClose = findMatchingParen(src, parenOpen);
    if (parenClose < 0) continue;
    const params = src.slice(parenOpen + 1, parenClose - 1);
    const tail = src.slice(parenClose);
    const braceIdx = tail.indexOf('{');
    const semiIdx = tail.indexOf(';');
    let endTail = braceIdx;
    if (semiIdx >= 0 && (braceIdx < 0 || semiIdx < braceIdx)) endTail = semiIdx;
    if (endTail < 0) endTail = tail.length;
    let retSection = tail.slice(0, endTail).trim();
    let retType = '';
    const arrowIdx = retSection.indexOf('->');
    if (arrowIdx >= 0) retType = retSection.slice(arrowIdx + 2).trim();

    // Build short signature.
    const compactedParams = compactSig(params);
    const compactedRet = retType ? ` -> ${compactSig(retType)}` : '';
    const sigShort = `fn ${fnName}(${compactedParams})${compactedRet}`;

    const line = lineFor(src, fm.index);
    const purpose = extractDocComment(src, attrStart);

    out.push({ name: fnName, sigShort, line, purpose });
  }
  return out;
}

/** Find invoke('<name>', ...) calls in a TS file. */
function parseTsInvokes(src) {
  const out = [];
  const re = /invoke\s*(?:<[^>]*>)?\s*\(\s*['"`](\w+)['"`]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push({ name: m[1], line: lineFor(src, m.index) });
  }
  return out;
}

function escapeMd(s) {
  if (!s) return '';
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

async function main() {
  const allRustFiles = (await walk(RUST_EXTRA_ROOT, (p) => p.endsWith('.rs'))).sort();
  const rustParsed = await Promise.all(
    allRustFiles.map(async (full) => {
      const src = await fs.readFile(full, 'utf8');
      const cmds = parseRustFile(src).map((c) => ({ ...c, file: rel(full) }));
      return { full, cmds };
    })
  );
  const byFile = new Map();
  const allCommands = [];
  const groupOrder = [];
  for (const { full, cmds } of rustParsed) {
    const isCommandsDir = full.startsWith(RUST_DIR + path.sep);
    const base = path.basename(full);
    if (isCommandsDir && base === 'mod.rs') continue;
    if (cmds.length === 0 && !isCommandsDir) continue;
    const groupKey = isCommandsDir ? base : rel(full);
    if (!byFile.has(groupKey)) {
      byFile.set(groupKey, []);
      groupOrder.push({ key: groupKey, isCommandsDir });
    }
    byFile.get(groupKey).push(...cmds);
    allCommands.push(...cmds);
  }
  groupOrder.sort((a, b) => {
    if (a.isCommandsDir !== b.isCommandsDir) return a.isCommandsDir ? -1 : 1;
    return a.key.localeCompare(b.key);
  });
  const rustFiles = groupOrder.map((g) => g.key);

  const tsFiles = [];
  for (const root of TS_ROOTS) {
    tsFiles.push(...(await walk(root, (p) => /\.(ts|tsx)$/.test(p) && !p.endsWith('.d.ts'))));
  }
  const tsParsed = await Promise.all(
    tsFiles.map(async (f) => ({ file: f, calls: parseTsInvokes(await fs.readFile(f, 'utf8')) }))
  );
  const callsitesByName = new Map();
  const allTsNames = new Set();
  for (const { file, calls } of tsParsed) {
    for (const c of calls) {
      allTsNames.add(c.name);
      if (!callsitesByName.has(c.name)) callsitesByName.set(c.name, []);
      callsitesByName.get(c.name).push({ file: rel(file), line: c.line });
    }
  }
  for (const arr of callsitesByName.values()) {
    arr.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
  }

  const lines = [];
  lines.push('<!-- GENERATED FILE — do not hand-edit. Regenerate via: node scripts/gen-tauri-ipc-doc.mjs -->');
  lines.push('');
  lines.push('# Tauri IPC Commands');
  lines.push('');
  lines.push('All Tauri IPC commands defined in `src-tauri/src/commands/` and their TypeScript callsites under `src/`.');
  lines.push('');

  let orphanCount = 0;
  const rustNames = new Set(allCommands.map((c) => c.name));

  for (const f of rustFiles) {
    const cmds = byFile.get(f);
    lines.push(`## ${f}`);
    lines.push('');
    if (cmds.length === 0) {
      lines.push('_No `#[tauri::command]` functions found._');
      lines.push('');
      continue;
    }
    lines.push('| Command | Rust signature | TS callsite(s) | Purpose |');
    lines.push('| --- | --- | --- | --- |');
    for (const c of cmds.sort((a, b) => a.name.localeCompare(b.name))) {
      const sigCell = `\`${escapeMd(c.sigShort)}\` ([${c.file}:${c.line}](${c.file}#L${c.line}))`;
      const callsites = callsitesByName.get(c.name) || [];
      let callCell;
      if (callsites.length === 0) {
        callCell = '_(none)_';
        orphanCount++;
      } else {
        callCell = callsites
          .map((cs) => `[${cs.file}:${cs.line}](${cs.file}#L${cs.line})`)
          .join('<br>');
      }
      lines.push(`| \`${c.name}\` | ${sigCell} | ${callCell} | ${escapeMd(c.purpose)} |`);
    }
    lines.push('');
  }

  const broken = [...allTsNames].filter((n) => !rustNames.has(n)).sort();
  if (broken.length > 0) {
    lines.push('## Unresolved TS callsites');
    lines.push('');
    lines.push('Commands referenced via `invoke()` in TS but not defined as `#[tauri::command]` in Rust. These may be built-in Tauri commands (e.g. `plugin:*`), or broken references.');
    lines.push('');
    lines.push('| Command | TS callsite(s) |');
    lines.push('| --- | --- |');
    for (const n of broken) {
      const cs = callsitesByName.get(n) || [];
      const cell = cs.map((c) => `[${c.file}:${c.line}](${c.file}#L${c.line})`).join('<br>');
      lines.push(`| \`${n}\` | ${cell} |`);
    }
    lines.push('');
  }

  lines.push('## Summary');
  lines.push('');
  lines.push(`- Total Rust commands: **${allCommands.length}**`);
  lines.push(`- Commands without a TS callsite (orphans): **${orphanCount}**`);
  lines.push(`- TS \`invoke()\` names with no Rust definition: **${broken.length}**`);
  lines.push('');

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, lines.join('\n'), 'utf8');

  console.log(`Wrote ${rel(OUT_PATH)}`);
  console.log(`  ${allCommands.length} commands, ${orphanCount} orphans, ${broken.length} unresolved TS calls`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
