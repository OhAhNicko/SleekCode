import type { CSSProperties, ReactNode } from "react";

interface LoadingDotsProps {
  /** The busy label; call sites keep their specific verb ("Searching",
   *  "Creating", …). Defaults to "Loading". */
  children?: ReactNode;
  style?: CSSProperties;
}

/**
 * The app-wide loading treatment: label + three dots revealing one after
 * another, left to right, on one shared 1.6s cycle (keyframes in index.css
 * and overlay.css — the overlay webview loads its own stylesheet).
 *
 * Deliberately inherits color and font-size from its wrapper so adopting it
 * is a pure text-node swap, and animates opacity only — the dots always
 * occupy their width, so rows and buttons never shift while animating.
 */
export default function LoadingDots({ children = "Loading", style }: LoadingDotsProps) {
  return (
    <span style={style}>
      {children}
      <span aria-hidden="true">
        <span className="ezy-dot ezy-dot-1">.</span>
        <span className="ezy-dot ezy-dot-2">.</span>
        <span className="ezy-dot ezy-dot-3">.</span>
      </span>
    </span>
  );
}
