/**
 * Inline SVG previews for the app-icon picker (Settings > Appearance).
 *
 * These mirror src-tauri/icons/variants/icon-{a,b,c,d}.svg 1:1 — that set is
 * the master. If a variant changes there, change it here too, then re-render
 * the PNGs (headless browser, transparent backdrop — see the SVG comments).
 */
import type { ReactNode } from "react";
import type { AppIconVariant } from "../lib/app-icon";

const VARIANT_MARKUP: Record<AppIconVariant, ReactNode> = {
  a: (
    <>
      <rect x="6" y="6" width="500" height="500" rx="112" fill="#80e2ad" />
      <path
        d="M 340 160 A 56 56 0 0 1 452 160 A 40 40 0 0 1 372 160 A 26 26 0 0 1 424 160 A 14 14 0 0 1 396 160"
        fill="none" stroke="#f4b4d1" strokeWidth="24" strokeLinecap="round"
      />
      <path d="M 300 362 C 344 340, 380 368, 430 344" fill="none" stroke="#fd8183" strokeWidth="26" strokeLinecap="round" />
      <path
        d="M 128 430 C 200 404, 260 452, 330 424 C 376 406, 404 424, 442 402"
        fill="none" stroke="#92bcff" strokeWidth="30" strokeLinecap="round"
      />
      <path d="M 170 150 L 310 256 L 170 362" fill="none" stroke="#131313" strokeWidth="64" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  b: (
    <>
      <rect x="6" y="6" width="500" height="500" rx="112" fill="#131313" />
      <rect x="28" y="28" width="456" height="456" rx="100" fill="#1d1d1d" />
      <circle cx="112" cy="100" r="22" fill="#fd8183" />
      <circle cx="174" cy="100" r="22" fill="#f4b4d1" />
      <circle cx="236" cy="100" r="22" fill="#92bcff" />
      <path d="M 132 178 L 256 284 L 132 390" fill="none" stroke="#80e2ad" strokeWidth="52" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="310" y="219" width="92" height="130" rx="30" fill="#80e2ad" />
    </>
  ),
  c: (
    <>
      <rect x="6" y="6" width="500" height="500" rx="112" fill="#131313" />
      <rect x="158" y="76" width="300" height="300" rx="66" fill="#fd8183" />
      <rect x="124" y="110" width="300" height="300" rx="66" fill="#f4b4d1" />
      <rect x="90" y="144" width="300" height="300" rx="66" fill="#92bcff" />
      <rect x="56" y="178" width="300" height="300" rx="66" fill="#80e2ad" />
      <path d="M 168 269 L 243 328 L 168 387" fill="none" stroke="#131313" strokeWidth="38" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  d: (
    <>
      <rect x="6" y="6" width="500" height="500" rx="112" fill="#131313" />
      <path d="M 330 262 L 150 396" fill="none" stroke="#92bcff" strokeWidth="76" strokeLinecap="round" />
      <path d="M 150 128 L 330 262" fill="none" stroke="#80e2ad" strokeWidth="76" strokeLinecap="round" />
      <rect x="368" y="320" width="76" height="112" rx="26" fill="#fd8183" />
    </>
  ),
};

export function AppIconPreview({ variant, size }: { variant: AppIconVariant; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true" style={{ display: "block", flexShrink: 0 }}>
      {VARIANT_MARKUP[variant]}
    </svg>
  );
}
