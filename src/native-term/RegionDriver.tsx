import { useMemo } from "react";
import { useNativePaneRegion } from "./useNativePaneRegion";

type Props = {
  termId: number;
  paneRef: React.RefObject<HTMLElement | null>;
  overlayRef: React.RefObject<HTMLElement | null>;
};

export function RegionDriver({ termId, paneRef, overlayRef }: Props) {
  const overlayRefs = useMemo(() => [overlayRef], [overlayRef]);
  useNativePaneRegion({ termId, paneRef, overlayRefs });
  return null;
}
