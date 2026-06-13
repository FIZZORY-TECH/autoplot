#!/usr/bin/env node
/**
 * generate-icons.mjs
 *
 * Convert the master logo SVG (`public/logo-mark.svg`) and the favicon-optimized
 * SVG (`public/favicon.svg`) into every icon raster the app ships:
 *   - Tauri bundle PNGs (32, 128, 128@2x, plus a 1024 master)
 *   - Windows Store tiles (Square*Logo.png set + StoreLogo.png)
 *   - Multi-res Windows icon.ico (16/32/48/64/128/256)
 *   - Multi-res web favicon.ico (16/32/48 from favicon.svg)
 *   - macOS icon.icns (darwin only — uses iconutil)
 *
 * Idempotent: re-running overwrites cleanly. SVG is rasterized fresh at every
 * target size so small icons stay crisp (no downscaling chain from 1024).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import pngToIco from "png-to-ico";

const execFileP = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const LOGO_SVG = path.join(repoRoot, "public", "logo-mark.svg");
const FAVICON_SVG = path.join(repoRoot, "public", "favicon.svg");
const ICONS_DIR = path.join(repoRoot, "src-tauri", "icons");
const PUBLIC_DIR = path.join(repoRoot, "public");

let logoBuf;
let faviconBuf;

// sharp's bundled librsvg does not parse oklch() — unparsed colors fall back to
// black, producing all-black rasters. Browsers render oklch() fine, so source
// SVGs stay in oklch (matching src/styles/tokens.css). We substitute hex
// equivalents only in the buffer fed to sharp. Conversions computed via
// OKLab → linear sRGB → sRGB gamma; the three values are the only oklch
// colors used across logo-mark.svg, logo.svg, favicon.svg.
const OKLCH_TO_HEX = [
  [/oklch\(\s*0\.11\s+0\.008\s+260\s*\)/g, "#030407"], // --bg-0
  [/oklch\(\s*0\.96\s+0\.005\s+260\s*\)/g, "#F0F2F5"], // --ink-0
  [/oklch\(\s*0\.82\s+0\.14\s+215\s*\)/g, "#35DAFC"],  // --accent
];

function svgForRaster(buf) {
  let s = buf.toString("utf8");
  for (const [re, hex] of OKLCH_TO_HEX) s = s.replace(re, hex);
  // Fail loud if any oklch() string survives — means a new color was added
  // upstream without a hex mapping here.
  if (/oklch\(/i.test(s)) {
    throw new Error("svgForRaster: unmapped oklch() color found — add it to OKLCH_TO_HEX");
  }
  return Buffer.from(s, "utf8");
}

async function assertExists(p) {
  try {
    await fs.access(p);
  } catch {
    console.error(`[icons] FATAL: required source file missing: ${p}`);
    process.exit(1);
  }
}

// Memoize per (svgBuffer, size) — sizes 32/128/256 are requested by 3+ stages
// (Tauri bundle PNGs, Win ICO, macOS iconset). WeakMap so buffers can be GC'd
// if main() releases the reference; per-buffer Map keyed by size.
const renderCache = new WeakMap();

function renderPngBuffer(svgBuffer, size) {
  let perBuf = renderCache.get(svgBuffer);
  if (!perBuf) {
    perBuf = new Map();
    renderCache.set(svgBuffer, perBuf);
  }
  let promise = perBuf.get(size);
  if (!promise) {
    // sharp's density is recomputed per call so each requested size gets
    // a crisp rasterization rather than a downscale chain.
    promise = sharp(svgBuffer, { density: Math.max(72, size * 2) })
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    perBuf.set(size, promise);
  }
  return promise;
}

async function renderPng(svgBuffer, size, outPath) {
  const buf = await renderPngBuffer(svgBuffer, size);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, buf);
  const kb = (buf.length / 1024).toFixed(1);
  console.log(`  ${path.relative(repoRoot, outPath)}  (${size}x${size}, ${kb} KB)`);
  return buf;
}

async function buildIco(svgBuffer, sizes, outPath) {
  const buffers = await Promise.all(sizes.map((s) => renderPngBuffer(svgBuffer, s)));
  const ico = await pngToIco(buffers);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, ico);
  const kb = (ico.length / 1024).toFixed(1);
  console.log(`  ${path.relative(repoRoot, outPath)}  (multi-res ${sizes.join("/")}, ${kb} KB)`);
}

async function buildIcns() {
  if (process.platform !== "darwin") {
    console.log("[icons] (F) skip icon.icns — non-darwin platform; iconutil unavailable.");
    return;
  }

  const tmpRoot = path.join(os.tmpdir(), "autoplot-iconset");
  const iconset = `${tmpRoot}.iconset`;
  await fs.rm(iconset, { recursive: true, force: true });
  await fs.mkdir(iconset, { recursive: true });

  const macSizes = [
    ["icon_16x16.png", 16],
    ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32],
    ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128],
    ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256],
    ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512],
    ["icon_512x512@2x.png", 1024],
  ];
  await Promise.all(
    macSizes.map(async ([name, size]) => {
      const buf = await renderPngBuffer(logoBuf, size);
      await fs.writeFile(path.join(iconset, name), buf);
    }),
  );

  const outIcns = path.join(ICONS_DIR, "icon.icns");
  try {
    await execFileP("iconutil", ["-c", "icns", "-o", outIcns, iconset]);
  } catch (e) {
    if (e.code === "ENOENT") {
      console.error("[icons] FATAL: iconutil not found on PATH — install Xcode Command Line Tools.");
      process.exit(1);
    }
    throw e;
  }
  const stat = await fs.stat(outIcns);
  const kb = (stat.size / 1024).toFixed(1);
  console.log(`  ${path.relative(repoRoot, outIcns)}  (icns, ${kb} KB)`);

  await fs.rm(iconset, { recursive: true, force: true });
}

async function main() {
  await assertExists(LOGO_SVG);
  await assertExists(FAVICON_SVG);
  logoBuf = svgForRaster(await fs.readFile(LOGO_SVG));
  faviconBuf = svgForRaster(await fs.readFile(FAVICON_SVG));

  await fs.mkdir(ICONS_DIR, { recursive: true });

  console.log("[icons] (A) Master raster:");
  await renderPng(logoBuf, 1024, path.join(ICONS_DIR, "icon.png"));

  console.log("[icons] (B) Tauri bundle PNGs:");
  await Promise.all([
    renderPng(logoBuf, 32, path.join(ICONS_DIR, "32x32.png")),
    renderPng(logoBuf, 128, path.join(ICONS_DIR, "128x128.png")),
    renderPng(logoBuf, 256, path.join(ICONS_DIR, "128x128@2x.png")),
  ]);

  console.log("[icons] (C) Windows Store tiles:");
  const winTiles = [
    ["Square30x30Logo.png", 30],
    ["Square44x44Logo.png", 44],
    ["Square71x71Logo.png", 71],
    ["Square89x89Logo.png", 89],
    ["Square107x107Logo.png", 107],
    ["Square142x142Logo.png", 142],
    ["Square150x150Logo.png", 150],
    ["Square284x284Logo.png", 284],
    ["Square310x310Logo.png", 310],
    ["StoreLogo.png", 50],
  ];
  await Promise.all(winTiles.map(([name, size]) => renderPng(logoBuf, size, path.join(ICONS_DIR, name))));

  console.log("[icons] (D) Windows multi-res icon.ico:");
  await buildIco(logoBuf, [16, 32, 48, 64, 128, 256], path.join(ICONS_DIR, "icon.ico"));

  console.log("[icons] (E) Web favicon.ico (from favicon.svg):");
  await buildIco(faviconBuf, [16, 32, 48], path.join(PUBLIC_DIR, "favicon.ico"));

  console.log("[icons] (F) macOS icon.icns:");
  await buildIcns();

  console.log("[icons] done.");
}

main().catch((err) => {
  console.error("[icons] FAILED:", err && err.stack ? err.stack : err);
  process.exit(1);
});
