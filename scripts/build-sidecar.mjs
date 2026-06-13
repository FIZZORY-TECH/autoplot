#!/usr/bin/env node
// build-sidecar.mjs
//
// Compiles the autoplot-mcp sidecar and installs it into
// src-tauri/binaries/autoplot-mcp-<triple> so Tauri's externalBin
// can bundle a current binary.
//
// NOTE: This script builds for the **host** triple only.
// Cross-platform / CI matrix builds (x86_64-apple-darwin, x86_64-pc-windows-msvc, etc.)
// are a follow-up task — add target-specific cargo invocations there.
//
// Usage:
//   node scripts/build-sidecar.mjs            # debug build
//   node scripts/build-sidecar.mjs --release  # release build

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const srcTauriDir = path.join(repoRoot, 'src-tauri');
const binariesDir = path.join(srcTauriDir, 'binaries');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive the host target triple from `rustc -vV`. */
async function hostTriple() {
  let out;
  try {
    out = await execFileP('rustc', ['-vV']);
  } catch (e) {
    console.error('[build-sidecar] ERROR: could not run `rustc -vV` — is Rust installed?');
    console.error(e.message);
    process.exit(1);
  }
  const line = out.stdout.split('\n').find((l) => l.startsWith('host:'));
  if (!line) {
    console.error('[build-sidecar] ERROR: could not find "host:" line in `rustc -vV` output.');
    process.exit(1);
  }
  return line.replace(/^host:\s*/, '').trim();
}

/** Run cargo build, streaming stdout/stderr live, resolve on exit 0, reject otherwise. */
function cargoBuild(args, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn('cargo', args, { cwd, stdio: 'inherit' });
    proc.on('error', (err) => {
      reject(new Error(`Failed to start cargo: ${err.message}`));
    });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`cargo exited with code ${code}`));
      }
    });
  });
}

/** Get mtime in ms, or -Infinity when the file doesn't exist. */
async function mtimeMs(p) {
  try {
    const s = await fs.stat(p);
    return s.mtimeMs;
  } catch {
    return -Infinity;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const isRelease = process.argv.includes('--release');
  const profile = isRelease ? 'release' : 'debug';

  const triple = await hostTriple();
  console.log(`[build-sidecar] host triple: ${triple}`);
  console.log(`[build-sidecar] profile:     ${profile}`);

  // 1. Run cargo build -p autoplot-mcp
  const cargoArgs = ['build', '-p', 'autoplot-mcp'];
  if (isRelease) cargoArgs.push('--release');

  console.log(`[build-sidecar] running: cargo ${cargoArgs.join(' ')}  (cwd: src-tauri/)`);
  try {
    await cargoBuild(cargoArgs, srcTauriDir);
  } catch (err) {
    console.error(`[build-sidecar] ERROR: cargo build failed — ${err.message}`);
    process.exit(1);
  }

  // 2. Locate source binary (add .exe on Windows)
  const exeSuffix = os.platform() === 'win32' ? '.exe' : '';
  const srcBin = path.join(srcTauriDir, 'target', profile, `autoplot-mcp${exeSuffix}`);

  try {
    await fs.access(srcBin);
  } catch {
    console.error(`[build-sidecar] ERROR: source binary not found after build: ${srcBin}`);
    process.exit(1);
  }

  // 3. Determine destination
  const destBin = path.join(binariesDir, `autoplot-mcp-${triple}${exeSuffix}`);

  // 4. Idempotency check: skip copy when installed binary is already up to date
  const srcMtime = await mtimeMs(srcBin);
  const destMtime = await mtimeMs(destBin);

  if (destMtime >= srcMtime) {
    console.log(`[build-sidecar] installed binary is already up to date — skipping copy.`);
    console.log(`[build-sidecar]   installed: ${destBin}`);
    return;
  }

  // 5. Ensure binaries/ directory exists and copy
  await fs.mkdir(binariesDir, { recursive: true });
  await fs.copyFile(srcBin, destBin);

  // 6. chmod 0o755 on non-Windows
  if (os.platform() !== 'win32') {
    await fs.chmod(destBin, 0o755);
  }

  console.log(`[build-sidecar] installed: ${path.relative(repoRoot, destBin)}`);
}

main().catch((err) => {
  console.error('[build-sidecar] FATAL:', err && err.stack ? err.stack : err);
  process.exit(1);
});
