/**
 * Generate NSIS installer branding bitmaps from the EzyDev logo.
 *
 * Sidebar: 164x314 BMP — dark bg, centered logo, "EzyDev" text, subtitle
 * Header:  150x57 BMP  — dark bg, small logo right-aligned, accent line
 *
 * Usage: node src-tauri/installer-assets/generate-bitmaps.mjs
 * Requires: sharp (installed via temp workspace — see wrapper script)
 */
import { createRequire } from "module";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Load sharp from temp workspace (ESM can't use NODE_PATH)
const SHARP_DIR = process.env.SHARP_DIR || "/tmp/ezydev-sharp-tmp";
const require = createRequire(join(SHARP_DIR, "node_modules", "sharp", "package.json"));
const sharp = require("sharp");

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(__dirname, "..", "icons");
const outDir = __dirname;

const BG = { r: 15, g: 20, b: 28 };

/**
 * Convert raw RGBA buffer to uncompressed 24-bit BMP (required by NSIS).
 */
function rgbaToBmp(rgba, width, height) {
  const rowBytes = width * 3;
  const paddedRow = (rowBytes + 3) & ~3;
  const pixelDataSize = paddedRow * height;
  const fileSize = 54 + pixelDataSize;
  const buf = Buffer.alloc(fileSize);

  buf.write("BM", 0);
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(0, 30);
  buf.writeUInt32LE(pixelDataSize, 34);
  buf.writeInt32LE(2835, 38);
  buf.writeInt32LE(2835, 42);

  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * width * 4;
    const dstRow = 54 + y * paddedRow;
    for (let x = 0; x < width; x++) {
      const si = srcRow + x * 4;
      const di = dstRow + x * 3;
      buf[di]     = rgba[si + 2]; // B
      buf[di + 1] = rgba[si + 1]; // G
      buf[di + 2] = rgba[si];     // R
    }
  }
  return buf;
}

/** Render an SVG string to a PNG buffer via sharp */
async function svgToPng(svg) {
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function generateSidebar() {
  const W = 164, H = 314;

  const bg = await sharp({
    create: { width: W, height: H, channels: 4, background: { ...BG, alpha: 255 } },
  }).png().toBuffer();

  const logoSize = 100;
  const logo = await sharp(join(iconsDir, "ezydev-1024.png"))
    .resize(logoSize, logoSize, { fit: "contain", background: { ...BG, alpha: 0 } })
    .png().toBuffer();

  const textPng = await svgToPng(`<svg width="120" height="28" xmlns="http://www.w3.org/2000/svg">
    <text x="60" y="22" text-anchor="middle"
          font-family="Segoe UI, Helvetica, Arial, sans-serif"
          font-size="22" font-weight="700" fill="#39d353">EzyDev</text>
  </svg>`);

  const subtitlePng = await svgToPng(`<svg width="140" height="18" xmlns="http://www.w3.org/2000/svg">
    <text x="70" y="14" text-anchor="middle"
          font-family="Segoe UI, Helvetica, Arial, sans-serif"
          font-size="11" font-weight="400" fill="#8b949e">AI Terminal Workspace</text>
  </svg>`);

  const linePng = await svgToPng(`<svg width="80" height="2" xmlns="http://www.w3.org/2000/svg">
    <rect width="80" height="1" rx="0.5" fill="#39d353" opacity="0.4"/>
  </svg>`);

  const versionPng = await svgToPng(`<svg width="120" height="14" xmlns="http://www.w3.org/2000/svg">
    <text x="60" y="11" text-anchor="middle"
          font-family="Segoe UI, Helvetica, Arial, sans-serif"
          font-size="10" font-weight="400" fill="#484f58">v0.1.0</text>
  </svg>`);

  const logoTop = 70;
  const textTop = logoTop + logoSize + 16;
  const subtitleTop = textTop + 28;
  const lineTop = subtitleTop + 22;
  const versionTop = H - 30;

  const raw = await sharp(bg)
    .composite([
      { input: logo, top: logoTop, left: Math.round((W - logoSize) / 2) },
      { input: textPng, top: textTop, left: Math.round((W - 120) / 2) },
      { input: subtitlePng, top: subtitleTop, left: Math.round((W - 140) / 2) },
      { input: linePng, top: lineTop, left: Math.round((W - 80) / 2) },
      { input: versionPng, top: versionTop, left: Math.round((W - 120) / 2) },
    ])
    .raw().toBuffer();

  writeFileSync(join(outDir, "sidebar.bmp"), rgbaToBmp(raw, W, H));
  console.log("  sidebar.bmp (164x314)");
}

async function generateHeader() {
  const W = 150, H = 57;
  const WHITE = { r: 255, g: 255, b: 255 };

  // White background to blend with NSIS default theme
  const bg = await sharp({
    create: { width: W, height: H, channels: 4, background: { ...WHITE, alpha: 255 } },
  }).png().toBuffer();

  const logoSize = 44;
  const logo = await sharp(join(iconsDir, "ezydev-1024.png"))
    .resize(logoSize, logoSize, { fit: "contain", background: { ...WHITE, alpha: 0 } })
    .png().toBuffer();

  const raw = await sharp(bg)
    .composite([
      { input: logo, top: Math.round((H - logoSize) / 2), left: Math.round((W - logoSize) / 2) },
    ])
    .raw().toBuffer();

  writeFileSync(join(outDir, "header.bmp"), rgbaToBmp(raw, W, H));
  console.log("  header.bmp (150x57)");
}

console.log("Generating NSIS branding assets...");
await generateSidebar();
await generateHeader();
console.log("Done!");
