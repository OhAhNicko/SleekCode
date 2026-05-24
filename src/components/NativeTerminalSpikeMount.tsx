import { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import NativeTerminalSpike from "./NativeTerminalSpike";

const SPIKE_HASH = "#native-spike";
const HOST_ID = "native-term-spike-host";

function NativeTerminalSpikeMount() {
  const [active, setActive] = useState(
    () => window.location.hash === SPIKE_HASH,
  );

  useEffect(() => {
    const onHash = () => setActive(window.location.hash === SPIKE_HASH);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (!active) return null;
  return <NativeTerminalSpike />;
}

let bootRoot: Root | null = null;

function bootstrap() {
  if (typeof document === "undefined") return;
  if (document.getElementById(HOST_ID)) return;
  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.pointerEvents = "none";
  host.style.zIndex = "99999";
  document.body.appendChild(host);
  bootRoot = createRoot(host);
  bootRoot.render(<NativeTerminalSpikeMount />);
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  } else {
    bootstrap();
  }
}

export default NativeTerminalSpikeMount;
