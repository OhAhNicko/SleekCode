import { getCurrentWindow } from "@tauri-apps/api/window";

const HANDLE = 6; // px — invisible resize border thickness

const directions = [
  // Edges
  { dir: "North", style: { top: 0, left: HANDLE, right: HANDLE, height: HANDLE, cursor: "n-resize" } },
  { dir: "South", style: { bottom: 0, left: HANDLE, right: HANDLE, height: HANDLE, cursor: "s-resize" } },
  { dir: "West", style: { left: 0, top: HANDLE, bottom: HANDLE, width: HANDLE, cursor: "w-resize" } },
  { dir: "East", style: { right: 0, top: HANDLE, bottom: HANDLE, width: HANDLE, cursor: "e-resize" } },
  // Corners
  { dir: "NorthWest", style: { top: 0, left: 0, width: HANDLE, height: HANDLE, cursor: "nw-resize" } },
  { dir: "NorthEast", style: { top: 0, right: 0, width: HANDLE, height: HANDLE, cursor: "ne-resize" } },
  { dir: "SouthWest", style: { bottom: 0, left: 0, width: HANDLE, height: HANDLE, cursor: "sw-resize" } },
  { dir: "SouthEast", style: { bottom: 0, right: 0, width: HANDLE, height: HANDLE, cursor: "se-resize" } },
] as const;

export default function WindowResizeHandles() {
  return (
    <>
      {directions.map(({ dir, style }) => (
        <div
          key={dir}
          onMouseDown={(e) => {
            e.preventDefault();
            getCurrentWindow().startResizeDragging(dir);
          }}
          style={{
            position: "fixed",
            zIndex: 9999,
            ...style,
          }}
        />
      ))}
    </>
  );
}
