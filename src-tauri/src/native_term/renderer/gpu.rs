// Process-wide GPU handles shared by every native pane.
//
// WHY: measured on the user's machine (`[native_term] Renderer::new` lines in
// the dlog), building a pane's renderer cost ~255ms steady-state and 821ms for
// the very first pane. Because `native_term_create` is synchronous, an 8-pane
// session restore serialised into ~2s of startup. The per-pane split was
// glyph/atlas ~110ms, pipelines ~75ms, device ~57ms, instance+adapter ~18ms —
// plus a ONE-OFF ~534ms on the first pane, which is DXGI/driver enumeration,
// not per-pane work at all.
//
// WHAT IS SHARED HERE (A3): the `Instance` and `Adapter`. Both are enumeration
// handles with no per-pane state, so sharing them carries no isolation cost —
// and it is what removes the 534ms: the first `request_adapter` loads the
// driver, and every later one drops from ~318ms to ~6ms (visible in the log:
// pane 1 vs panes 2..8). `prewarm()` moves even that first cost off the
// critical path, onto a background thread at app start.
//
// WHAT IS NOT SHARED HERE: the `Device`/`Queue`. Those stay per pane for now;
// sharing them is the opt-in refactor tracked in tasks/todo.md, and it lands
// behind a Settings toggle so both paths can be measured side by side.
//
// wgpu 22's handles are Arc-backed and cheap to clone, so nothing here needs
// its own Arc and no `Renderer` field type changes.

use std::sync::{Arc, Mutex};

use serde::Serialize;

/// The shared `Instance`. `Arc` because wgpu 22's `Instance` is not clonable.
static INSTANCE: Mutex<Option<Arc<wgpu::Instance>>> = Mutex::new(None);
/// The shared `Adapter`, created WITH a real surface — see `shared_adapter_for`.
static ADAPTER: Mutex<Option<Arc<wgpu::Adapter>>> = Mutex::new(None);

/// The shared `Instance`, built on first use.
pub fn instance() -> Result<Arc<wgpu::Instance>, String> {
    let mut guard = INSTANCE.lock().map_err(|_| "gpu: INSTANCE poisoned".to_string())?;
    if let Some(existing) = guard.as_ref() {
        return Ok(existing.clone());
    }
    let t0 = std::time::Instant::now();
    let instance = Arc::new(wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::DX12 | wgpu::Backends::VULKAN | wgpu::Backends::METAL,
        ..Default::default()
    }));
    let line = format!(
        "[native_term] gpu: shared instance built {:.1}ms",
        t0.elapsed().as_secs_f32() * 1000.0
    );
    eprintln!("{line}");
    crate::debug_log::dlog(&line);
    *guard = Some(instance.clone());
    Ok(instance)
}

/// The shared `Adapter`, IF it can drive `surface`.
///
/// Created with `compatible_surface: Some(..)` on the first pane, because an
/// adapter picked without a surface can come back unable to present to a
/// WebView2-sibling child HWND — which is exactly what happened on this machine
/// and, combined with a mismatched device, aborted the process inside
/// `Surface::configure` (2026-07-26). Every later pane re-verifies with
/// `is_surface_supported`; a pane the shared adapter cannot serve gets `Err`
/// and must build BOTH its own adapter and its own device.
pub fn shared_adapter_for(
    instance: &wgpu::Instance,
    surface: &wgpu::Surface<'static>,
) -> Result<Arc<wgpu::Adapter>, String> {
    let mut guard = ADAPTER.lock().map_err(|_| "gpu: ADAPTER poisoned".to_string())?;
    if let Some(existing) = guard.as_ref() {
        return if existing.is_surface_supported(surface) {
            Ok(existing.clone())
        } else {
            Err("shared adapter cannot drive this surface".to_string())
        };
    }
    let t0 = std::time::Instant::now();
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        compatible_surface: Some(surface),
        force_fallback_adapter: false,
    }))
    .ok_or_else(|| "no compatible wgpu adapter".to_string())?;
    if !adapter.is_surface_supported(surface) {
        return Err("adapter reports the surface unsupported".to_string());
    }
    let line = format!(
        "[native_term] gpu: shared adapter built {:.1}ms",
        t0.elapsed().as_secs_f32() * 1000.0
    );
    eprintln!("{line}");
    crate::debug_log::dlog(&line);
    let adapter = Arc::new(adapter);
    *guard = Some(adapter.clone());
    Ok(adapter)
}

/// Drop the shared handles so the next pane rebuilds them (device-loss path).
#[allow(dead_code)]
pub fn invalidate() {
    if let Ok(mut guard) = ADAPTER.lock() {
        if guard.take().is_some() {
            eprintln!("[native_term] gpu: shared adapter dropped — next pane rebuilds");
        }
    }
}

/// Warm the driver + fonts off the critical path, at app start.
///
/// The adapter built here is DISCARDED: its only job is to make Windows load
/// the DXGI/driver DLLs, which is the ~500ms the first pane used to pay. The
/// adapter the panes actually use is created later, with a real surface.
pub fn prewarm() {
    std::thread::spawn(|| {
        // Fonts first: pure CPU, so it cannot be blocked by the driver load,
        // and it is the larger per-pane saving of the two.
        super::fonts::prewarm();
        let Ok(instance) = instance() else { return };
        let t0 = std::time::Instant::now();
        let warm = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: None,
            force_fallback_adapter: false,
        }));
        let line = format!(
            "[native_term] gpu: driver warm {:.1}ms (adapter {})",
            t0.elapsed().as_secs_f32() * 1000.0,
            if warm.is_some() { "found" } else { "none" }
        );
        eprintln!("{line}");
        crate::debug_log::dlog(&line);
    });
}

// ── Shared Device/Queue (opt-in) ───────────────────────────────────────────
//
// Behind the Settings toggle. When OFF, every pane builds its own Device and
// Queue exactly as before — that path stays live so the two can be measured
// against each other, and so a bad day with the shared one is a toggle away
// from the known-good behaviour.
//
// A device is only valid with resources created from it, so the quad program
// cache lives HERE, next to the device it belongs to: handing a pipeline built
// on one device to a pane rendering on another is rejected by wgpu.

use super::quad_pipeline::QuadProgram;
use std::collections::HashMap;

pub struct SharedDevice {
    /// `Arc` because wgpu 22's `Device`/`Queue` are not clonable handles;
    /// panes hold cloned Arcs of the same pair.
    pub device: Arc<wgpu::Device>,
    pub queue: Arc<wgpu::Queue>,
    /// Quad programs, one per surface format. Compiled on first use, then
    /// reused by every pane on this device.
    programs: Mutex<HashMap<wgpu::TextureFormat, Arc<QuadProgram>>>,
}

impl SharedDevice {
    /// The quad program for `format`, compiling it once per format.
    pub fn program(&self, format: wgpu::TextureFormat) -> Arc<QuadProgram> {
        let mut guard = self.programs.lock().expect("gpu: program cache poisoned");
        if let Some(p) = guard.get(&format) {
            return p.clone();
        }
        let p = Arc::new(QuadProgram::new(&self.device, format));
        guard.insert(format, p.clone());
        p
    }
}

static DEVICE: Mutex<Option<Arc<SharedDevice>>> = Mutex::new(None);

/// The shared Device/Queue, built on first use. Only reached when a pane opts
/// in via the toggle.
/// The shared Device/Queue, built from `adapter` on first use.
///
/// MUST be the adapter the caller's surface was validated against — a device
/// from one adapter cannot configure a surface belonging to another, and wgpu
/// enforces that with a validation panic that aborts the process.
pub fn shared_device(adapter: &wgpu::Adapter) -> Result<Arc<SharedDevice>, String> {
    let mut guard = DEVICE.lock().map_err(|_| "gpu: DEVICE poisoned".to_string())?;
    if let Some(existing) = guard.as_ref() {
        return Ok(existing.clone());
    }
    let t0 = std::time::Instant::now();
    let (device, queue) = pollster::block_on(adapter.request_device(
        &wgpu::DeviceDescriptor {
            label: Some("native_term shared device"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::downlevel_defaults()
                .using_resolution(adapter.limits()),
            memory_hints: wgpu::MemoryHints::default(),
        },
        None,
    ))
    .map_err(|e| format!("request_device (shared): {e}"))?;

    // An uncaptured error on a SHARED device would otherwise take out every
    // pane at once through wgpu's default handler, which panics on some
    // backends — and a panic crossing the wnd_proc FFI boundary aborts the
    // process. Log instead, and drop the shared context so the next pane
    // rebuilds rather than inheriting a poisoned device.
    device.on_uncaptured_error(Box::new(|e| {
        eprintln!("[native_term] gpu: uncaptured wgpu error on shared device: {e}");
        crate::debug_log::dlog(&format!(
            "[native_term] gpu: uncaptured wgpu error on shared device: {e}"
        ));
        // The comment above promised this and the code did not do it: without
        // dropping the shared context, EVERY later pane kept inheriting the
        // poisoned device, so one GPU error degraded the whole session rather
        // than a single pane. `invalidate_device` already existed for exactly
        // this and was only wired to the pipeline's surface-loss path.
        //
        // try_lock, NOT lock: this callback is driven by wgpu from inside device
        // work, which can be reached while another thread is building the shared
        // device and holding DEVICE. Blocking there would deadlock the render
        // path, and a deadlock inside a wnd_proc is far worse than a stale
        // handle. If the lock is busy, whoever holds it is already rebuilding.
        invalidate_device_if_free();
    }));

    let line = format!(
        "[native_term] gpu: shared device built {:.1}ms",
        t0.elapsed().as_secs_f32() * 1000.0
    );
    eprintln!("{line}");
    crate::debug_log::dlog(&line);

    let shared = Arc::new(SharedDevice {
        device: Arc::new(device),
        queue: Arc::new(queue),
        programs: Mutex::new(HashMap::new()),
    });
    *guard = Some(shared.clone());
    Ok(shared)
}

/// Drop the shared Device/Queue (device-loss recovery). Panes already holding
/// clones keep their dead one until they are rebuilt; this decides what the
/// NEXT pane gets.
pub fn invalidate_device() {
    if let Ok(mut guard) = DEVICE.lock() {
        if guard.take().is_some() {
            eprintln!("[native_term] gpu: shared device dropped — next pane builds a fresh one");
        }
    }
}

/// Non-blocking `invalidate_device`, for callers that must never wait on the
/// lock — specifically the uncaptured-error callback, which wgpu can invoke
/// from inside device work while another thread holds DEVICE.
fn invalidate_device_if_free() {
    match DEVICE.try_lock() {
        Ok(mut guard) => {
            if guard.take().is_some() {
                eprintln!(
                    "[native_term] gpu: shared device dropped after an uncaptured error — next pane builds a fresh one"
                );
            }
        }
        Err(_) => {
            eprintln!(
                "[native_term] gpu: shared device busy while handling an uncaptured error; leaving it to the holder"
            );
        }
    }
}


// ── Which GPU are we actually on? ──────────────────────────────────────────
//
// Recorded from the adapter a pane REALLY renders with, not from the throwaway
// one `prewarm` uses to load the driver — those can differ, and reporting a
// backend we are not using would be worse than reporting nothing. Surfaced in
// Settings and in the log, because when a pane goes black or a drag stutters,
// the first useful question is which backend and which GPU.

/// Adapter identity for the Settings readout.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    /// "DirectX 12" / "Vulkan" / "Metal" / "OpenGL".
    pub backend: String,
    /// Adapter name, e.g. "NVIDIA GeForce RTX 4090".
    pub name: String,
    pub driver: String,
    /// False when this pane fell back to its own adapter because the shared one
    /// could not drive its surface — worth seeing, since it means the fast path
    /// is not in use.
    pub shared: bool,
}

static ADAPTER_INFO: Mutex<Option<GpuInfo>> = Mutex::new(None);

fn backend_label(b: wgpu::Backend) -> &'static str {
    match b {
        wgpu::Backend::Dx12 => "DirectX 12",
        wgpu::Backend::Vulkan => "Vulkan",
        wgpu::Backend::Metal => "Metal",
        wgpu::Backend::Gl => "OpenGL",
        wgpu::Backend::BrowserWebGpu => "WebGPU",
        wgpu::Backend::Empty => "none",
    }
}

/// Record the adapter a pane actually built on. Called from `Renderer::new`
/// once the adapter/device pair is settled.
pub fn record_adapter_info(adapter: &wgpu::Adapter, shared: bool) {
    let info = adapter.get_info();
    let dto = GpuInfo {
        backend: backend_label(info.backend).to_string(),
        name: info.name.clone(),
        driver: if info.driver_info.is_empty() {
            info.driver.clone()
        } else {
            format!("{} {}", info.driver, info.driver_info)
        },
        shared,
    };
    let mut guard = match ADAPTER_INFO.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    // Log only on a CHANGE — this runs per pane, and one line per pane would
    // drown the timing lines it sits next to.
    let changed = guard.as_ref().map(|p| p.backend != dto.backend || p.name != dto.name || p.shared != dto.shared).unwrap_or(true);
    if changed {
        let line = format!(
            "[native_term] gpu: {} on {} ({}), adapter {}",
            dto.backend,
            dto.name,
            dto.driver,
            if shared { "shared" } else { "per-pane" }
        );
        eprintln!("{line}");
        crate::debug_log::dlog(&line);
    }
    *guard = Some(dto);
}

/// The adapter a pane is actually rendering on, or None before the first native
/// pane exists (the real adapter is only created once a surface does).
pub fn adapter_info() -> Option<GpuInfo> {
    ADAPTER_INFO.lock().ok().and_then(|g| g.clone())
}
