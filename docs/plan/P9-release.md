# P9 — Packaging & Release

> Source: [`docs/plan/README.md`](./README.md). Read it first for global context.

**Inputs:** Output of [P8](./P8-polish.md) (release-candidate).

**Goal:** a signed, distributable desktop binary plus public quickstart.

## Checklist

- [ ] **P9-1** Tauri build for macOS (universal — Apple Silicon + Intel).
- [ ] **P9-2** Code signing — Apple Developer ID; notarize via `xcrun notarytool`.
- [ ] **P9-3** Optional: Windows + Linux builds via GitHub Actions matrix.
- [ ] **P9-4** Auto-updater wired via Tauri updater plugin (optional; can defer to v1.1).
- [ ] **P9-5** README quickstart:
  1. Install Node 20 + Rust + Claude Code CLI.
  2. `claude` (login).
  3. Download `.dmg` → drag to Applications.
  4. First-run sets up SQLite + verifies `claude --version`.
- [ ] **P9-6** Public docs site (optional) or GitHub Pages with screenshots.
- [ ] **P9-7** `CHANGELOG.md` start.
- [ ] **P9-8** Tag `v1.0.0`.

## Acceptance

Signed `.dmg` installs cleanly on a fresh macOS, finds local `claude`, fetches BTC bars, generates a research dataset, and persists across restart.

## Hands off to

This is the terminal phase. Post-release: triage feedback, iterate on minor versions, watch for new Claude CLI capabilities to surface (per [README §2.6](./README.md#26-claude-cli-capability-surface--full-parity) ongoing maintenance commitment).
