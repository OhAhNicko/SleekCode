import { useEffect, useState } from "react";

export type Orientation = "portrait" | "landscape";

function getOrientation(): Orientation {
  if (typeof window === "undefined") return "landscape";
  return window.innerHeight > window.innerWidth ? "portrait" : "landscape";
}

export function useOrientation(): Orientation {
  const [orientation, setOrientation] = useState<Orientation>(getOrientation);

  useEffect(() => {
    const update = () => setOrientation(getOrientation());

    window.addEventListener("resize", update);

    const mql = window.matchMedia("(orientation: portrait)");
    const mqlHandler = () => setOrientation(getOrientation());
    if (mql.addEventListener) mql.addEventListener("change", mqlHandler);
    else mql.addListener(mqlHandler);

    return () => {
      window.removeEventListener("resize", update);
      if (mql.removeEventListener) mql.removeEventListener("change", mqlHandler);
      else mql.removeListener(mqlHandler);
    };
  }, []);

  return orientation;
}
