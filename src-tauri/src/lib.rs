mod pty;

use std::process::Command;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Serialize;
use tauri::Manager;

/// Spawn `wsl.exe` with `CREATE_NO_WINDOW` so no console window flashes.
#[cfg(target_os = "windows")]
fn wsl_command() -> Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let mut cmd = Command::new("wsl.exe");
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(not(target_os = "windows"))]
fn wsl_command() -> Command {
    Command::new("wsl.exe")
}

/// Remove all Windows 11 DWM borders including the 1px top non-client border.
#[cfg(target_os = "windows")]
mod win32_border {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, Ordering};

    const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
    const DWMWCP_DONOTROUND: u32 = 1;
    const DWMWCP_ROUND: u32 = 2;
    const DWMWA_BORDER_COLOR: u32 = 34;
    const DWMWA_COLOR_NONE: u32 = 0xFFFFFFFE;
    const WM_NCCALCSIZE: u32 = 0x0083;
    const WM_SIZE: u32 = 0x0005;
    const WM_USER: u32 = 0x0400;
    const WM_WEBVIEW_REPAINT: u32 = WM_USER + 100;
    const SIZE_MINIMIZED: usize = 1;
    const GWL_STYLE: i32 = -16;
    const WS_THICKFRAME: isize = 0x00040000;
    const WS_MAXIMIZE: isize = 0x01000000;
    const SWP_FRAMECHANGED: u32 = 0x0020;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOZORDER: u32 = 0x0004;
    const MONITOR_DEFAULTTONEAREST: u32 = 2;

    static WAS_MINIMIZED: AtomicBool = AtomicBool::new(false);

    #[repr(C)]
    #[derive(Copy, Clone)]
    struct RECT {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[repr(C)]
    struct MONITORINFO {
        cb_size: u32,
        rc_monitor: RECT,
        rc_work: RECT,
        dw_flags: u32,
    }

    #[repr(C)]
    struct NCCALCSIZE_PARAMS {
        rgrc: [RECT; 3],
        lppos: *mut c_void,
    }

    extern "system" {
        fn DwmSetWindowAttribute(
            hwnd: *mut c_void,
            dw_attribute: u32,
            pv_attribute: *const c_void,
            cb_attribute: u32,
        ) -> i32;

        fn SetWindowSubclass(
            hwnd: *mut c_void,
            pfn_subclass: Option<unsafe extern "system" fn(
                *mut c_void, u32, usize, isize, usize, usize,
            ) -> isize>,
            uid_subclass: usize,
            ref_data: usize,
        ) -> i32;

        fn DefSubclassProc(
            hwnd: *mut c_void,
            msg: u32,
            wparam: usize,
            lparam: isize,
        ) -> isize;

        fn GetWindowLongPtrW(hwnd: *mut c_void, index: i32) -> isize;
        fn SetWindowLongPtrW(hwnd: *mut c_void, index: i32, new_long: isize) -> isize;
        fn SetWindowPos(
            hwnd: *mut c_void,
            insert_after: *mut c_void,
            x: i32, y: i32, cx: i32, cy: i32,
            flags: u32,
        ) -> i32;
        fn MonitorFromWindow(hwnd: *mut c_void, flags: u32) -> *mut c_void;
        fn GetMonitorInfoW(monitor: *mut c_void, info: *mut MONITORINFO) -> i32;
        fn GetWindowRect(hwnd: *mut c_void, rect: *mut RECT) -> i32;
        fn PostMessageW(hwnd: *mut c_void, msg: u32, wparam: usize, lparam: isize) -> i32;
    }

    /// Window subclass proc that intercepts WM_NCCALCSIZE to remove the
    /// 1px top non-client border Windows draws on frameless windows.
    ///
    /// Handles three cases:
    /// - **Maximized** (Win+Up or maximize button): WS_MAXIMIZE is set, and
    ///   WS_THICKFRAME extends the window rect ~8px beyond screen edges.
    ///   We set client rect = monitor work area.
    /// - **Snapped** (Win+Left/Right): WS_MAXIMIZE is NOT set, but
    ///   WS_THICKFRAME still causes the proposed rect to overshoot the work
    ///   area. We clamp the client rect to the work area boundaries so the
    ///   window doesn't extend behind the taskbar.
    /// - **Normal** (floating window): proposed rect is within the work area,
    ///   no clamping needed. We return 0 to remove all non-client area.
    unsafe extern "system" fn subclass_proc(
        hwnd: *mut c_void,
        msg: u32,
        wparam: usize,
        lparam: isize,
        _uid_subclass: usize,
        _ref_data: usize,
    ) -> isize {
        // Track minimize → restore to fix WebView2 blank screen.
        // WebView2 in frameless windows doesn't repaint its compositor
        // surface after restore. We detect restore and post a deferred
        // message that forces a 1px resize cycle, which triggers
        // WebView2's put_Bounds and repaints the content.
        if msg == WM_SIZE {
            if wparam == SIZE_MINIMIZED {
                WAS_MINIMIZED.store(true, Ordering::SeqCst);
            } else if WAS_MINIMIZED.swap(false, Ordering::SeqCst) {
                // Defer the resize to after Windows finishes the restore
                PostMessageW(hwnd, WM_WEBVIEW_REPAINT, 0, 0);
            }
        }

        if msg == WM_WEBVIEW_REPAINT {
            let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
            if (style & WS_MAXIMIZE) != 0 {
                // Maximized: can't resize, force frame recalculation instead
                SetWindowPos(
                    hwnd, std::ptr::null_mut(), 0, 0, 0, 0,
                    SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER,
                );
            } else {
                // Normal/snapped: resize +1px then back to force WebView2 relayout
                let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };
                GetWindowRect(hwnd, &mut rect);
                let w = rect.right - rect.left;
                let h = rect.bottom - rect.top;
                SetWindowPos(hwnd, std::ptr::null_mut(), rect.left, rect.top, w + 1, h, SWP_NOZORDER);
                SetWindowPos(hwnd, std::ptr::null_mut(), rect.left, rect.top, w, h, SWP_NOZORDER);
            }
            return 0;
        }

        if msg == WM_NCCALCSIZE && wparam == 1 {
            let params = &mut *(lparam as *mut NCCALCSIZE_PARAMS);
            let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            let mut mi = MONITORINFO {
                cb_size: std::mem::size_of::<MONITORINFO>() as u32,
                rc_monitor: RECT { left: 0, top: 0, right: 0, bottom: 0 },
                rc_work: RECT { left: 0, top: 0, right: 0, bottom: 0 },
                dw_flags: 0,
            };
            if GetMonitorInfoW(monitor, &mut mi) != 0 {
                let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
                if (style & WS_MAXIMIZE) != 0 {
                    // Maximized: client rect = work area exactly.
                    // WS_THICKFRAME extends the window rect beyond screen edges;
                    // using the work area prevents corner clipping and taskbar overlap.
                    params.rgrc[0] = mi.rc_work;
                } else {
                    // Normal or snapped: clamp to work area if overshooting.
                    // During snap (Win+Left/Right), WS_THICKFRAME causes the
                    // proposed rect to extend a few pixels beyond the work area.
                    // For normal floating windows the proposed rect is already
                    // within bounds, so the clamps are no-ops.
                    let r = &mut params.rgrc[0];
                    if r.top < mi.rc_work.top {
                        r.top = mi.rc_work.top;
                    }
                    if r.bottom > mi.rc_work.bottom {
                        r.bottom = mi.rc_work.bottom;
                    }
                    if r.left < mi.rc_work.left {
                        r.left = mi.rc_work.left;
                    }
                    if r.right > mi.rc_work.right {
                        r.right = mi.rc_work.right;
                    }
                }
            }
            return 0;
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    pub fn set_corner_preference(hwnd: *mut c_void, rounded: bool) {
        unsafe {
            let corner_pref = if rounded { DWMWCP_ROUND } else { DWMWCP_DONOTROUND };
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &corner_pref as *const u32 as *const c_void,
                std::mem::size_of::<u32>() as u32,
            );
        }
    }

    pub fn remove_border(hwnd: *mut c_void) {
        unsafe {
            // 1) Enable rounded corners (Windows 11+)
            let corner_pref = DWMWCP_ROUND;
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &corner_pref as *const u32 as *const c_void,
                std::mem::size_of::<u32>() as u32,
            );

            // 2) Remove DWM side/bottom border color
            let color = DWMWA_COLOR_NONE;
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_BORDER_COLOR,
                &color as *const u32 as *const c_void,
                std::mem::size_of::<u32>() as u32,
            );

            // 3) Subclass the window to intercept WM_NCCALCSIZE and kill the top border
            SetWindowSubclass(hwnd, Some(subclass_proc), 1, 0);

            // 4) Force Windows to recalculate the frame
            let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
            SetWindowLongPtrW(hwnd, GWL_STYLE, style | WS_THICKFRAME);
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                0, 0, 0, 0,
                SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER,
            );
        }
    }
}

#[tauri::command]
async fn ssh_ls(
    host: String,
    username: String,
    path: String,
    identity_file: Option<String>,
) -> Result<Vec<String>, String> {
    let user_host = format!("{}@{}", username, host);

    let mut cmd = Command::new("ssh");
    cmd.args(["-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=5"]);

    if let Some(ref key) = identity_file {
        cmd.args(["-i", key]);
    }

    cmd.arg(&user_host);
    cmd.arg(format!(
        "ls -1pa {}",
        shell_escape(&path)
    ));

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run ssh: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("SSH ls failed: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let entries: Vec<String> = stdout
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect();

    Ok(entries)
}

#[tauri::command]
async fn ssh_test_connection(
    host: String,
    username: String,
    identity_file: Option<String>,
) -> Result<bool, String> {
    let user_host = format!("{}@{}", username, host);

    let mut cmd = Command::new("ssh");
    cmd.args([
        "-o", "StrictHostKeyChecking=no",
        "-o", "ConnectTimeout=5",
        "-o", "BatchMode=yes",
    ]);

    if let Some(ref key) = identity_file {
        cmd.args(["-i", key]);
    }

    cmd.arg(&user_host);
    cmd.arg("echo ok");

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run ssh: {}", e))?;

    Ok(output.status.success())
}

#[tauri::command]
async fn ssh_keygen(key_path: String) -> Result<String, String> {
    let path = std::path::Path::new(&key_path);
    if path.exists() {
        return Err(format!("Key already exists at {}", key_path));
    }
    // Ensure ~/.ssh directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create .ssh directory: {}", e))?;
    }

    let output = Command::new("ssh-keygen")
        .args(["-t", "ed25519", "-f", &key_path, "-N", ""])
        .output()
        .map_err(|e| format!("Failed to run ssh-keygen: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ssh-keygen failed: {}", stderr.trim()));
    }

    // Return the public key content
    let pub_path = format!("{}.pub", key_path);
    std::fs::read_to_string(&pub_path)
        .map_err(|e| format!("Failed to read public key: {}", e))
}

#[tauri::command]
async fn ssh_check_key(key_path: String) -> Result<bool, String> {
    Ok(std::path::Path::new(&key_path).exists())
}

#[derive(Serialize)]
struct SshKeyInfo {
    path: String,
    name: String,
    key_type: String,
    comment: String,
}

#[tauri::command]
async fn ssh_list_keys() -> Result<Vec<SshKeyInfo>, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "Cannot determine home directory".to_string())?;
    let ssh_dir = std::path::PathBuf::from(&home).join(".ssh");
    if !ssh_dir.exists() {
        return Ok(vec![]);
    }

    let mut keys = Vec::new();
    let entries = std::fs::read_dir(&ssh_dir)
        .map_err(|e| format!("Failed to read .ssh directory: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Read error: {}", e))?;
        let path = entry.path();
        if path.is_file() {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name.ends_with(".pub") {
                    let private_name = &name[..name.len() - 4];
                    let private_path = ssh_dir.join(private_name);
                    if private_path.exists() && private_path.is_file() {
                        // Parse .pub file for type + comment
                        let (key_type, comment) = match std::fs::read_to_string(&path) {
                            Ok(content) => {
                                let parts: Vec<&str> = content.trim().splitn(3, ' ').collect();
                                let kt = parts.first()
                                    .map(|t| t.strip_prefix("ssh-").unwrap_or(t).to_string())
                                    .unwrap_or_default();
                                let cm = if parts.len() >= 3 {
                                    parts[2].trim().to_string()
                                } else {
                                    String::new()
                                };
                                (kt, cm)
                            }
                            Err(_) => (String::new(), String::new()),
                        };

                        keys.push(SshKeyInfo {
                            path: private_path.to_string_lossy().to_string(),
                            name: private_name.to_string(),
                            key_type,
                            comment,
                        });
                    }
                }
            }
        }
    }
    keys.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(keys)
}

#[tauri::command]
async fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {}", e))
}

#[tauri::command]
async fn write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, &content).map_err(|e| format!("Failed to write file: {}", e))
}

#[derive(Serialize)]
struct GitFileStatus {
    path: String,
    status: String,
    old_path: Option<String>,
}

#[derive(Serialize)]
struct GitBranchInfo {
    current: String,
    branches: Vec<String>,
}

#[derive(Serialize)]
struct FileEntry {
    name: String,
    path: String,
    is_directory: bool,
    size: u64,
}

#[derive(Serialize)]
struct SearchResult {
    file_path: String,
    file_name: String,
    line_number: usize,
    line_content: String,
}

#[tauri::command]
async fn list_dir(path: String) -> Result<Vec<FileEntry>, String> {
    let entries = std::fs::read_dir(&path)
        .map_err(|e| format!("Failed to read directory: {}", e))?;

    let mut dirs: Vec<FileEntry> = Vec::new();
    let mut files: Vec<FileEntry> = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden files
        if name.starts_with('.') {
            continue;
        }

        let metadata = entry.metadata().map_err(|e| format!("Failed to read metadata: {}", e))?;
        let fe = FileEntry {
            name: name.clone(),
            path: entry.path().to_string_lossy().to_string(),
            is_directory: metadata.is_dir(),
            size: metadata.len(),
        };

        if metadata.is_dir() {
            dirs.push(fe);
        } else {
            files.push(fe);
        }
    }

    // Sort alphabetically within each group
    dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    // Dirs first, then files
    dirs.extend(files);
    Ok(dirs)
}

#[tauri::command]
async fn search_in_files(
    directory: String,
    query: String,
    max_results: Option<usize>,
) -> Result<Vec<SearchResult>, String> {
    let max = max_results.unwrap_or(100);
    let mut results: Vec<SearchResult> = Vec::new();
    let query_lower = query.to_lowercase();

    fn walk_dir(
        dir: &std::path::Path,
        query_lower: &str,
        results: &mut Vec<SearchResult>,
        max: usize,
    ) {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };

        for entry in entries {
            if results.len() >= max {
                return;
            }

            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };

            let name = entry.file_name().to_string_lossy().to_string();

            // Skip hidden and common ignored dirs
            if name.starts_with('.') {
                continue;
            }

            let path = entry.path();
            let metadata = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };

            if metadata.is_dir() {
                // Skip common large/irrelevant directories
                if matches!(name.as_str(), "node_modules" | "target" | "dist" | ".git" | "build" | "__pycache__") {
                    continue;
                }
                walk_dir(&path, query_lower, results, max);
            } else {
                // Skip binary/large files by extension
                let ext = path.extension()
                    .map(|e| e.to_string_lossy().to_lowercase())
                    .unwrap_or_default();
                if matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "ico" | "svg" | "woff" | "woff2" | "ttf" | "eot" | "mp3" | "mp4" | "zip" | "tar" | "gz" | "exe" | "dll" | "so" | "dylib" | "wasm" | "lock") {
                    continue;
                }

                // Skip large files (>1MB)
                if metadata.len() > 1_048_576 {
                    continue;
                }

                let content = match std::fs::read_to_string(&path) {
                    Ok(c) => c,
                    Err(_) => continue,
                };

                let file_name = name;
                let file_path = path.to_string_lossy().to_string();

                for (i, line) in content.lines().enumerate() {
                    if results.len() >= max {
                        return;
                    }
                    if line.to_lowercase().contains(query_lower) {
                        results.push(SearchResult {
                            file_path: file_path.clone(),
                            file_name: file_name.clone(),
                            line_number: i + 1,
                            line_content: line.trim().to_string(),
                        });
                    }
                }
            }
        }
    }

    let dir_path = std::path::Path::new(&directory);
    walk_dir(dir_path, &query_lower, &mut results, max);

    Ok(results)
}

/// Run a git command, routing through wsl.exe when the directory is a WSL UNC path
/// (e.g. `\\wsl.localhost\Ubuntu-24.04\home\...`). Windows git.exe can't use UNC
/// paths as current_dir, so we convert to a Linux path and run via wsl.exe.
fn run_git_owned(directory: &str, args: &[String]) -> Result<std::process::Output, String> {
    let strs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run_git(directory, &strs)
}

/// Extract WSL distro and Linux path from a UNC path.
/// Returns None for non-WSL paths.
fn parse_wsl_path(directory: &str) -> Option<(String, String)> {
    let normalized = directory.replace('/', "\\");
    let is_wsl = normalized.starts_with("\\\\wsl.localhost\\") || normalized.starts_with("\\\\wsl$\\");
    if !is_wsl { return None; }
    let trimmed = normalized.trim_start_matches("\\\\wsl.localhost\\").trim_start_matches("\\\\wsl$\\");
    match trimmed.find('\\') {
        Some(pos) => Some((trimmed[..pos].to_string(), trimmed[pos..].replace('\\', "/"))),
        None => Some((trimmed.to_string(), "/".to_string())),
    }
}

/// Run a bash script in a directory, routing through WSL for UNC paths.
/// Pipes script through stdin (proven pattern — `bash -c` mangles multi-line args via wsl.exe).
fn run_bash_script(directory: &str, script: &str) -> Result<std::process::Output, String> {
    use std::io::Write;

    if let Some((distro, linux_path)) = parse_wsl_path(directory) {
        let full_script = format!("cd '{}' && {}", linux_path, script);
        let mut child = wsl_command()
            .args(["-d", &distro, "--", "bash"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn wsl: {}", e))?;

        if let Some(ref mut stdin) = child.stdin {
            let _ = stdin.write_all(full_script.as_bytes());
        }
        drop(child.stdin.take());

        child.wait_with_output()
            .map_err(|e| format!("Failed to wait for wsl: {}", e))
    } else {
        let mut child = Command::new("bash")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .current_dir(directory)
            .spawn()
            .map_err(|e| format!("Failed to spawn bash: {}", e))?;

        if let Some(ref mut stdin) = child.stdin {
            let _ = stdin.write_all(script.as_bytes());
        }
        drop(child.stdin.take());

        child.wait_with_output()
            .map_err(|e| format!("Failed to wait for bash: {}", e))
    }
}

fn run_git(directory: &str, args: &[&str]) -> Result<std::process::Output, String> {
    // Detect WSL UNC paths: \\wsl.localhost\Distro\... or \\wsl$\Distro\...
    let normalized = directory.replace('/', "\\");
    let is_wsl = normalized.starts_with("\\\\wsl.localhost\\") || normalized.starts_with("\\\\wsl$\\");

    if is_wsl {
        // Extract distro and convert to Linux path
        // \\wsl.localhost\Ubuntu-24.04\home\nicko\projects\nano → distro=Ubuntu-24.04, linux_path=/home/nicko/projects/nano
        let trimmed = normalized.trim_start_matches("\\\\wsl.localhost\\").trim_start_matches("\\\\wsl$\\");
        let (distro, linux_path) = match trimmed.find('\\') {
            Some(pos) => (&trimmed[..pos], trimmed[pos..].replace('\\', "/")),
            None => (trimmed, "/".to_string()),
        };

        // Use `cd <path> && git <args>` via bash — matches what the user
        // types in their shell exactly. `git -C` can behave subtly differently
        // (e.g. .gitignore resolution, submodule paths).
        let quoted_args: Vec<String> = args.iter()
            .map(|a| format!("'{}'", a.replace('\'', "'\\''")))
            .collect();
        let script = format!("cd '{}' && git {}", linux_path, quoted_args.join(" "));

        let mut child = wsl_command()
            .args(["-d", distro, "--", "bash", "-c", &script])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to run git via wsl: {}", e))?;

        child.wait_with_output()
            .map_err(|e| format!("Failed to wait for wsl git: {}", e))
    } else {
        Command::new("git")
            .args(args)
            .current_dir(directory)
            .output()
            .map_err(|e| format!("Failed to run git: {}", e))
    }
}

#[tauri::command]
async fn git_is_repo(directory: String) -> Result<bool, String> {
    let output = run_git(&directory, &["rev-parse", "--is-inside-work-tree"])?;
    Ok(output.status.success())
}

#[tauri::command]
async fn git_status(directory: String) -> Result<Vec<GitFileStatus>, String> {
    let output = run_git(&directory, &["status", "--porcelain", "-uall"])?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git status failed: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut files = Vec::new();

    for line in stdout.lines() {
        if line.len() < 3 { continue; }
        let status = line[..2].trim().to_string();
        let rest = &line[3..];

        // Handle renames: "R  old -> new"
        if status.starts_with('R') {
            if let Some(arrow_pos) = rest.find(" -> ") {
                files.push(GitFileStatus {
                    path: rest[arrow_pos + 4..].to_string(),
                    status,
                    old_path: Some(rest[..arrow_pos].to_string()),
                });
            } else {
                files.push(GitFileStatus { path: rest.to_string(), status, old_path: None });
            }
        } else {
            files.push(GitFileStatus { path: rest.to_string(), status, old_path: None });
        }
    }

    Ok(files)
}

#[tauri::command]
async fn git_diff(directory: String, file_path: Option<String>, compare_to: Option<String>) -> Result<String, String> {
    let mut combined = String::new();

    match &compare_to {
        Some(branch) => {
            // Compare against branch
            let mut args = vec!["diff".to_string(), format!("{}...HEAD", branch)];
            if let Some(ref fp) = file_path {
                args.push("--".to_string());
                args.push(fp.clone());
            }
            let output = run_git_owned(&directory, &args)?;
            combined = String::from_utf8_lossy(&output.stdout).to_string();
        }
        None => {
            // Unstaged changes
            let mut args1 = vec!["diff".to_string()];
            if let Some(ref fp) = file_path {
                args1.push("--".to_string());
                args1.push(fp.clone());
            }
            let output1 = run_git_owned(&directory, &args1)?;
            combined.push_str(&String::from_utf8_lossy(&output1.stdout));

            // Staged changes
            let mut args2 = vec!["diff".to_string(), "--cached".to_string()];
            if let Some(ref fp) = file_path {
                args2.push("--".to_string());
                args2.push(fp.clone());
            }
            let output2 = run_git_owned(&directory, &args2)?;
            combined.push_str(&String::from_utf8_lossy(&output2.stdout));
        }
    }

    Ok(combined)
}

#[tauri::command]
async fn git_branches(directory: String) -> Result<GitBranchInfo, String> {
    // Current branch — `git branch --show-current` (empty string in detached HEAD)
    let current_output = run_git(&directory, &["branch", "--show-current"])?;
    let current = String::from_utf8_lossy(&current_output.stdout).trim().to_string();
    let current = if current.is_empty() { "HEAD".to_string() } else { current };

    // Local branches only — remote branches can't be switched to directly.
    let branches_output = run_git(&directory, &["branch"])?;
    let branches: Vec<String> = String::from_utf8_lossy(&branches_output.stdout)
        .lines()
        .map(|l| l.trim().trim_start_matches("* ").trim_start_matches("remotes/").to_string())
        .filter(|l| !l.is_empty() && !l.contains("->"))
        .collect();

    Ok(GitBranchInfo { current, branches })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitDiffStats {
    files_changed: u32,
    insertions: u32,
    deletions: u32,
}

/// Parse a `git diff --shortstat` line like " 3 files changed, 156 insertions(+), 22 deletions(-)"
fn parse_shortstat(line: &str) -> (u32, u32, u32) {
    let mut files = 0u32;
    let mut ins = 0u32;
    let mut del = 0u32;
    for part in line.split(',') {
        let part = part.trim();
        if part.contains("file") {
            if let Some(n) = part.split_whitespace().next().and_then(|s| s.parse().ok()) {
                files = n;
            }
        } else if part.contains("insertion") {
            if let Some(n) = part.split_whitespace().next().and_then(|s| s.parse().ok()) {
                ins = n;
            }
        } else if part.contains("deletion") {
            if let Some(n) = part.split_whitespace().next().and_then(|s| s.parse().ok()) {
                del = n;
            }
        }
    }
    (files, ins, del)
}

#[tauri::command]
async fn git_diff_stats(directory: String) -> Result<GitDiffStats, String> {
    // Single bash script — one WSL process for all three values:
    //   files = git status --porcelain=v1 | wc -l
    //   add/del = git diff --numstat HEAD | awk sum
    let script = r#"
files=$(git status --porcelain=v1 | wc -l | tr -d ' ')
read add del <<<$(git diff --numstat HEAD 2>/dev/null | awk '{a+=$1; d+=$2} END {print a+0, d+0}')
echo "$files $add $del"
"#;

    let output = run_bash_script(&directory, script)?;
    let line = String::from_utf8_lossy(&output.stdout).trim().to_string();

    // Parse "files add del" e.g. "5 589 6"
    let parts: Vec<&str> = line.split_whitespace().collect();
    let files_changed = parts.first().and_then(|s| s.parse().ok()).unwrap_or(0);
    let insertions = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    let deletions = parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);

    Ok(GitDiffStats {
        files_changed,
        insertions,
        deletions,
    })
}

#[tauri::command]
async fn git_switch_branch(directory: String, branch: String) -> Result<(), String> {
    let output = run_git(&directory, &["switch", &branch])?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.trim().to_string());
    }
    Ok(())
}

#[tauri::command]
async fn git_revert_hunk(directory: String, patch: String) -> Result<(), String> {
    let temp_dir = std::env::temp_dir();
    let temp_path = temp_dir.join(format!("ezydev-patch-{}.patch", std::process::id()));

    std::fs::write(&temp_path, &patch)
        .map_err(|e| format!("Failed to write temp patch: {}", e))?;

    let output = Command::new("git")
        .args(["apply", "--reverse"])
        .arg(&temp_path)
        .current_dir(&directory)
        .output()
        .map_err(|e| format!("Failed to run git apply: {}", e))?;

    let _ = std::fs::remove_file(&temp_path);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git apply --reverse failed: {}", stderr.trim()));
    }

    Ok(())
}

#[tauri::command]
async fn git_discard_file(directory: String, file_path: String, is_untracked: bool) -> Result<(), String> {
    if is_untracked {
        let full_path = std::path::Path::new(&directory).join(&file_path);
        std::fs::remove_file(&full_path)
            .map_err(|e| format!("Failed to remove file: {}", e))?;
    } else {
        let output = run_git(&directory, &["checkout", "--", &file_path])?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("git checkout failed: {}", stderr.trim()));
        }
    }
    Ok(())
}

#[tauri::command]
async fn git_add(directory: String, files: Vec<String>) -> Result<(), String> {
    if files.is_empty() { return Ok(()); }
    let mut args: Vec<String> = vec!["add".to_string(), "--".to_string()];
    args.extend(files);
    let output = run_git_owned(&directory, &args)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git add failed: {}", stderr.trim()));
    }
    Ok(())
}

#[tauri::command]
async fn git_reset_files(directory: String, files: Vec<String>) -> Result<(), String> {
    if files.is_empty() { return Ok(()); }
    let mut args: Vec<String> = vec!["reset".into(), "HEAD".into(), "--".into()];
    args.extend(files);
    let output = run_git_owned(&directory, &args)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git reset failed: {}", stderr.trim()));
    }
    Ok(())
}

#[tauri::command]
async fn git_commit(directory: String, message: String) -> Result<String, String> {
    let output = run_git(&directory, &["commit", "-m", &message])?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[tauri::command]
async fn git_push(directory: String, set_upstream: bool) -> Result<String, String> {
    let output = if set_upstream {
        run_git(&directory, &["push", "-u", "origin", "HEAD"])?
    } else {
        run_git(&directory, &["push"])?
    };
    // git push writes progress to stderr even on success
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        return Err(format!("{}\n{}", stdout.trim(), stderr.trim()).trim().to_string());
    }
    Ok(format!("{}\n{}", stdout.trim(), stderr.trim()).trim().to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitAheadBehind {
    ahead: u32,
    behind: u32,
    has_remote: bool,
}

#[tauri::command]
async fn git_ahead_behind(directory: String) -> Result<GitAheadBehind, String> {
    // Check if there's an upstream
    let upstream = run_git(&directory, &["rev-parse", "--abbrev-ref", "@{u}"]);
    match upstream {
        Ok(ref out) if out.status.success() => {},
        _ => return Ok(GitAheadBehind { ahead: 0, behind: 0, has_remote: false }),
    }
    // Count ahead/behind
    let output = run_git(&directory, &["rev-list", "--left-right", "--count", "HEAD...@{u}"])?;
    let line = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let parts: Vec<&str> = line.split('\t').collect();
    let ahead = parts.first().and_then(|s| s.parse().ok()).unwrap_or(0);
    let behind = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    Ok(GitAheadBehind { ahead, behind, has_remote: true })
}

#[tauri::command]
async fn git_run_typecheck(directory: String) -> Result<String, String> {
    let script = r#"
if [ -f tsconfig.json ]; then
  npx tsc --noEmit 2>&1; echo "EXITCODE:$?"
elif [ -f Cargo.toml ]; then
  cargo check --all-targets 2>&1; echo "EXITCODE:$?"
elif ls *.csproj >/dev/null 2>&1 || ls *.sln >/dev/null 2>&1; then
  dotnet build --no-restore 2>&1; echo "EXITCODE:$?"
elif [ -f go.mod ]; then
  go vet ./... 2>&1; echo "EXITCODE:$?"
else
  echo "EXITCODE:SKIP"
fi
"#;
    let output = run_bash_script(&directory, script)?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if let Some(pos) = text.rfind("EXITCODE:") {
        let code_str = text[pos + 9..].trim();
        if code_str == "SKIP" {
            Ok("__SKIP__".to_string())
        } else {
            let code: i32 = code_str.parse().unwrap_or(-1);
            let errors = text[..pos].trim().to_string();
            if code == 0 {
                Ok(String::new())
            } else {
                Ok(errors)
            }
        }
    } else {
        Err(format!("Typecheck failed unexpectedly: {}", text))
    }
}

#[tauri::command]
async fn git_run_lint(directory: String) -> Result<String, String> {
    let script = r#"
if [ -f Makefile ] && grep -q '^lint:' Makefile 2>/dev/null; then
  make lint 2>&1; echo "EXITCODE:$?"
elif [ -f package.json ] && grep -q '"lint"' package.json 2>/dev/null; then
  PM="npm"
  [ -f pnpm-lock.yaml ] && PM="pnpm"
  [ -f yarn.lock ] && PM="yarn"
  $PM run lint 2>&1; echo "EXITCODE:$?"
elif [ -f pyproject.toml ] || [ -f ruff.toml ] || [ -f .ruff.toml ]; then
  if command -v ruff >/dev/null 2>&1; then
    ruff check . 2>&1; echo "EXITCODE:$?"
  elif command -v flake8 >/dev/null 2>&1; then
    flake8 . 2>&1; echo "EXITCODE:$?"
  else
    echo "EXITCODE:SKIP"
  fi
elif [ -f go.mod ]; then
  if command -v golangci-lint >/dev/null 2>&1; then
    golangci-lint run ./... 2>&1; echo "EXITCODE:$?"
  else
    echo "EXITCODE:SKIP"
  fi
elif [ -f Cargo.toml ]; then
  cargo clippy --all-targets --all-features 2>&1; echo "EXITCODE:$?"
elif [ -f pom.xml ]; then
  mvn checkstyle:check -q 2>&1; echo "EXITCODE:$?"
elif [ -f build.gradle ] || [ -f build.gradle.kts ]; then
  if [ -x ./gradlew ]; then
    ./gradlew check 2>&1; echo "EXITCODE:$?"
  elif command -v gradle >/dev/null 2>&1; then
    gradle check 2>&1; echo "EXITCODE:$?"
  else
    echo "EXITCODE:SKIP"
  fi
elif ls *.csproj >/dev/null 2>&1 || ls *.sln >/dev/null 2>&1; then
  dotnet format --verify-no-changes 2>&1; echo "EXITCODE:$?"
elif [ -f Gemfile ]; then
  if command -v rubocop >/dev/null 2>&1; then
    rubocop 2>&1; echo "EXITCODE:$?"
  else
    echo "EXITCODE:SKIP"
  fi
elif [ -f composer.json ]; then
  if command -v phpstan >/dev/null 2>&1; then
    phpstan analyse 2>&1; echo "EXITCODE:$?"
  elif command -v phpcs >/dev/null 2>&1; then
    phpcs . 2>&1; echo "EXITCODE:$?"
  else
    echo "EXITCODE:SKIP"
  fi
elif [ -f pubspec.yaml ]; then
  if command -v flutter >/dev/null 2>&1; then
    flutter analyze 2>&1; echo "EXITCODE:$?"
  elif command -v dart >/dev/null 2>&1; then
    dart analyze 2>&1; echo "EXITCODE:$?"
  else
    echo "EXITCODE:SKIP"
  fi
elif [ -f mix.exs ]; then
  if mix help credo >/dev/null 2>&1; then
    mix credo 2>&1; echo "EXITCODE:$?"
  else
    echo "EXITCODE:SKIP"
  fi
elif [ -f Package.swift ]; then
  if command -v swiftlint >/dev/null 2>&1; then
    swiftlint lint 2>&1; echo "EXITCODE:$?"
  else
    echo "EXITCODE:SKIP"
  fi
else
  echo "EXITCODE:SKIP"
fi
"#;
    let output = run_bash_script(&directory, script)?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if let Some(pos) = text.rfind("EXITCODE:") {
        let code_str = text[pos + 9..].trim();
        if code_str == "SKIP" {
            Ok("__SKIP__".to_string())
        } else {
            let code: i32 = code_str.parse().unwrap_or(-1);
            let errors = text[..pos].trim().to_string();
            if code == 0 {
                Ok(String::new())
            } else {
                Ok(errors)
            }
        }
    } else {
        Err(format!("Lint check failed unexpectedly: {}", text))
    }
}

#[tauri::command]
async fn git_run_tests(directory: String) -> Result<String, String> {
    let script = r#"
if [ -f Makefile ] && grep -q '^test:' Makefile 2>/dev/null; then
  make test 2>&1; echo "EXITCODE:$?"
elif [ -f package.json ] && grep -q '"test"' package.json 2>/dev/null; then
  PM="npm"
  [ -f pnpm-lock.yaml ] && PM="pnpm"
  [ -f yarn.lock ] && PM="yarn"
  CI=true $PM run test 2>&1; echo "EXITCODE:$?"
elif [ -f pyproject.toml ] || [ -f setup.py ] || [ -f setup.cfg ]; then
  if [ -d tests ] || [ -d test ] || grep -rq 'pytest' pyproject.toml 2>/dev/null || [ -f pytest.ini ] || [ -f conftest.py ]; then
    python3 -m pytest -q 2>&1; echo "EXITCODE:$?"
  else
    python3 -m unittest discover 2>&1; echo "EXITCODE:$?"
  fi
elif [ -f go.mod ]; then
  go test ./... 2>&1; echo "EXITCODE:$?"
elif [ -f Cargo.toml ]; then
  cargo test 2>&1; echo "EXITCODE:$?"
elif [ -f pom.xml ]; then
  mvn test -q 2>&1; echo "EXITCODE:$?"
elif [ -f build.gradle ] || [ -f build.gradle.kts ]; then
  if [ -x ./gradlew ]; then
    ./gradlew test 2>&1; echo "EXITCODE:$?"
  elif command -v gradle >/dev/null 2>&1; then
    gradle test 2>&1; echo "EXITCODE:$?"
  else
    echo "EXITCODE:SKIP"
  fi
elif ls *.csproj >/dev/null 2>&1 || ls *.sln >/dev/null 2>&1; then
  dotnet test 2>&1; echo "EXITCODE:$?"
elif [ -f Gemfile ]; then
  if [ -d spec ]; then
    bundle exec rspec 2>&1; echo "EXITCODE:$?"
  else
    bundle exec rake test 2>&1; echo "EXITCODE:$?"
  fi
elif [ -f composer.json ]; then
  if [ -x ./vendor/bin/phpunit ]; then
    ./vendor/bin/phpunit 2>&1; echo "EXITCODE:$?"
  else
    echo "EXITCODE:SKIP"
  fi
elif [ -f pubspec.yaml ]; then
  if command -v flutter >/dev/null 2>&1 && grep -q 'flutter' pubspec.yaml 2>/dev/null; then
    flutter test 2>&1; echo "EXITCODE:$?"
  elif command -v dart >/dev/null 2>&1; then
    dart test 2>&1; echo "EXITCODE:$?"
  else
    echo "EXITCODE:SKIP"
  fi
elif [ -f mix.exs ]; then
  mix test 2>&1; echo "EXITCODE:$?"
elif [ -f Package.swift ]; then
  swift test 2>&1; echo "EXITCODE:$?"
elif [ -f build.zig ]; then
  zig build test 2>&1; echo "EXITCODE:$?"
else
  echo "EXITCODE:SKIP"
fi
"#;
    let output = run_bash_script(&directory, script)?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if let Some(pos) = text.rfind("EXITCODE:") {
        let code_str = text[pos + 9..].trim();
        if code_str == "SKIP" {
            Ok("__SKIP__".to_string())
        } else {
            let code: i32 = code_str.parse().unwrap_or(-1);
            let errors = text[..pos].trim().to_string();
            if code == 0 {
                Ok(String::new())
            } else {
                Ok(errors)
            }
        }
    } else {
        Err(format!("Test check failed unexpectedly: {}", text))
    }
}

#[derive(Serialize)]
struct ClipboardImageResult {
    path: String,
    data_uri: String,
}

#[derive(Serialize)]
struct ClipboardPollResult {
    seq: u32,
    image: Option<ClipboardImageResult>,
}

#[cfg(target_os = "windows")]
extern "system" {
    fn GetClipboardSequenceNumber() -> u32;
}

/// Fast clipboard poll: check if clipboard changed since `last_seq`.
/// Only reads the image (slow call) when the sequence number changes.
/// Returns the current sequence number and optionally the new image.
#[tauri::command]
async fn poll_clipboard_image(last_seq: u32) -> Result<ClipboardPollResult, String> {
    #[cfg(target_os = "windows")]
    {
        let seq = unsafe { GetClipboardSequenceNumber() };
        if seq == last_seq {
            return Ok(ClipboardPollResult { seq, image: None });
        }

        // Clipboard changed — try to read image
        match save_clipboard_image().await {
            Ok(result) => Ok(ClipboardPollResult {
                seq,
                image: Some(result),
            }),
            Err(_) => {
                // Clipboard changed but no image (e.g. text was copied)
                Ok(ClipboardPollResult { seq, image: None })
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        // macOS: use NSPasteboard changeCount (increments on each clipboard change)
        let output = Command::new("osascript")
            .args(["-e", "tell application \"System Events\" to return (the clipboard info)"])
            .output();
        // Simple hash of clipboard info as change counter
        let seq = match output {
            Ok(o) => {
                let s = String::from_utf8_lossy(&o.stdout);
                let mut hash: u32 = 0;
                for b in s.bytes() { hash = hash.wrapping_mul(31).wrapping_add(b as u32); }
                hash
            }
            Err(_) => 0,
        };

        if seq == last_seq {
            return Ok(ClipboardPollResult { seq, image: None });
        }

        match save_clipboard_image().await {
            Ok(result) => Ok(ClipboardPollResult { seq, image: Some(result) }),
            Err(_) => Ok(ClipboardPollResult { seq, image: None }),
        }
    }

    #[cfg(target_os = "linux")]
    {
        let _ = last_seq;
        Err("Clipboard polling not yet supported on Linux".to_string())
    }
}

/// Launch the screenshot tool (Snipping Tool on Windows, screencapture on macOS).
#[tauri::command]
async fn launch_snipping_tool() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // Start the Screen Sketch / Snip & Sketch overlay directly.
        // This opens the region-selection UI (same as Win+Shift+S).
        let _ = Command::new("cmd.exe")
            .args(["/C", "start", "ms-screenclip:"])
            .output();
    }
    #[cfg(target_os = "macos")]
    {
        // macOS interactive screenshot (region select, saves to clipboard)
        let _ = Command::new("screencapture")
            .args(["-i", "-c"])
            .output();
    }
    #[cfg(target_os = "linux")]
    {
        // Try common Linux screenshot tools
        let _ = Command::new("gnome-screenshot")
            .args(["-a", "-c"])
            .output()
            .or_else(|_| Command::new("xfce4-screenshooter")
                .args(["-r", "-c"])
                .output());
    }
    Ok(())
}

/// Read image from the clipboard and save as PNG.
/// Uses PowerShell on Windows, osascript/pngpaste on macOS.
/// Returns the file path and a data URI for thumbnail preview.
#[tauri::command]
async fn save_clipboard_image() -> Result<ClipboardImageResult, String> {
    let dir = std::env::temp_dir().join("ezydev");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let filename = format!("clipboard-{}.png", timestamp);
    let path = dir.join(&filename);
    let path_str = path.to_string_lossy().to_string();

    #[cfg(target_os = "windows")]
    {
        // Use PowerShell to read image from Windows clipboard and save as PNG.
        let ps_path = path_str.replace('\'', "''");
        let script = format!(
            "Add-Type -AssemblyName System.Windows.Forms; \
             $img = [System.Windows.Forms.Clipboard]::GetImage(); \
             if ($img) {{ $img.Save('{}', [System.Drawing.Imaging.ImageFormat]::Png) }} \
             else {{ exit 1 }}",
            ps_path
        );

        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
            .map_err(|e| format!("Failed to run PowerShell: {}", e))?;

        if !output.status.success() || !path.exists() {
            return Err("No image in clipboard".to_string());
        }
    }

    #[cfg(target_os = "macos")]
    {
        // Try pngpaste first (brew install pngpaste), fall back to osascript
        let pngpaste = Command::new("pngpaste")
            .arg(&path_str)
            .output();

        if pngpaste.is_err() || !pngpaste.as_ref().unwrap().status.success() || !path.exists() {
            // Fallback: use osascript to save clipboard image
            let script = format!(
                "use framework \"AppKit\"\n\
                 set pb to current application's NSPasteboard's generalPasteboard()\n\
                 set imgData to pb's dataForType:(current application's NSPasteboardTypePNG)\n\
                 if imgData is missing value then error \"No image\"\n\
                 imgData's writeToFile:\"{}\" atomically:true",
                path_str.replace('"', "\\\"")
            );
            let output = Command::new("osascript")
                .args(["-l", "AppleScript", "-e", &script])
                .output()
                .map_err(|e| format!("Failed to run osascript: {}", e))?;

            if !output.status.success() || !path.exists() {
                return Err("No image in clipboard".to_string());
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        // Try xclip first, fall back to xsel
        let output = Command::new("xclip")
            .args(["-selection", "clipboard", "-t", "image/png", "-o"])
            .output();

        match output {
            Ok(o) if o.status.success() && !o.stdout.is_empty() => {
                std::fs::write(&path, &o.stdout)
                    .map_err(|e| format!("Failed to write clipboard image: {}", e))?;
            }
            _ => return Err("No image in clipboard".to_string()),
        }
    }

    // Read the saved PNG and encode as data URI for frontend thumbnail
    let png_bytes = std::fs::read(&path)
        .map_err(|e| format!("Failed to read saved image: {}", e))?;

    // Enforce 20MB limit
    if png_bytes.len() > 20 * 1024 * 1024 {
        let _ = std::fs::remove_file(&path);
        return Err("Image too large (max 20MB)".to_string());
    }

    let b64 = STANDARD.encode(&png_bytes);
    let data_uri = format!("data:image/png;base64,{}", b64);

    Ok(ClipboardImageResult {
        path: path_str,
        data_uri,
    })
}

/// Clean up old clipboard images from the ezydev temp directory.
#[tauri::command]
async fn cleanup_clipboard_images(max_age_secs: Option<u64>) -> Result<(), String> {
    let max_age = std::time::Duration::from_secs(max_age_secs.unwrap_or(86400));
    let dir = std::env::temp_dir().join("ezydev");

    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(()), // Dir doesn't exist yet — nothing to clean
    };

    let now = std::time::SystemTime::now();

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("clipboard-") || !name.ends_with(".png") {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            if let Ok(modified) = meta.modified() {
                if let Ok(age) = now.duration_since(modified) {
                    if age > max_age {
                        let _ = std::fs::remove_file(entry.path());
                    }
                }
            }
        }
    }

    Ok(())
}

/// Simple shell escaping for paths (wraps in single quotes)
fn shell_escape(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Resolve CLI paths and PATH inside WSL in one shot.
/// Returns a JSON-like map: { "PATH": "/usr/local/bin:...", "claude": "/home/.../.npm/bin/claude", ... }
///
/// NOTE: nvm can cause the exported PATH (seen by child processes) to differ from
/// bash's internal $PATH variable. Using `$()` subshells inherits the wrong PATH,
/// so `which` inside `$()` fails to find nvm-installed binaries. We avoid this by
/// running `which` as direct commands and using `env` to read the exported PATH.
#[tauri::command]
async fn wsl_resolve_cli_env(cli_names: Vec<String>) -> Result<std::collections::BTreeMap<String, String>, String> {
    // Use a unique delimiter to parse multi-line output without $() subshells.
    // $() subshells inherit bash's internal $PATH which may lack nvm entries,
    // while direct child processes get the correct exported PATH.
    let delim = "___EZYDEV_DELIM___";
    let mut script_parts: Vec<String> = Vec::new();

    // Get the EXPORTED PATH via env (direct command, no $() subshell).
    // Using sed directly in pipeline avoids the subshell PATH problem.
    script_parts.push("env | sed -n 's/^PATH=/PATH=/p'".to_string());
    script_parts.push("echo \"DISTRO=$WSL_DISTRO_NAME\"".to_string());

    // Run each `which` as a direct command, separated by delimiters
    for name in &cli_names {
        script_parts.push(format!("echo \"{delim}{name}\""));
        script_parts.push(format!("which {} 2>/dev/null || true", name));
    }

    let script = script_parts.join("; ");

    let output = wsl_command()
        .args(["--", "bash", "-lic", &script])
        .output()
        .map_err(|e| format!("Failed to run wsl: {}", e))?;

    if !output.status.success() {
        return Err("WSL command failed".to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut result = std::collections::BTreeMap::new();

    // Parse key=value lines (PATH, DISTRO)
    // Then parse delimited which output
    let mut current_cli: Option<String> = None;
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with(delim) {
            current_cli = Some(line[delim.len()..].to_string());
        } else if let Some(ref cli) = current_cli {
            // This line is the output of `which <cli>` — an absolute path
            if line.starts_with('/') {
                result.insert(cli.clone(), line.to_string());
            }
            current_cli = None;
        } else if let Some((key, value)) = line.split_once('=') {
            let value = value.trim();
            if !value.is_empty() {
                result.insert(key.to_string(), value.to_string());
            }
        }
    }

    Ok(result)
}

/// Find the most recent Claude Code session ID for a given project.
/// Claude stores sessions at ~/.claude/projects/<encoded-path>/<uuid>.jsonl
/// where <encoded-path> replaces '/' with '-' in the absolute project path.
/// Case can vary (e.g. "Documents" vs "documents") on WSL with Windows paths.
#[tauri::command]
async fn get_claude_session_id(project_path: String, exclude_ids: Vec<String>, max_age_secs: Option<u64>) -> Result<Option<String>, String> {
    let encoded = project_path.replace('/', "-");

    // Try exact match first, then case-insensitive glob for /mnt/ paths where
    // Windows case folding creates multiple folder variants (Documents vs documents).
    // When max_age_secs is set, use find -mmin to filter out stale sessions.
    let script = if let Some(age) = max_age_secs {
        let mmin_val = (age + 59) / 60; // ceiling division to minutes
        format!(
            "find ~/.claude/projects/{enc}/ -maxdepth 1 -name '*.jsonl' -mmin -{mmin} 2>/dev/null | xargs -r ls -1t 2>/dev/null | sed 's|.*/||;s|\\.jsonl$||'; \
             for d in ~/.claude/projects/*/; do \
               base=$(basename \"$d\"); \
               if [ \"$(echo \"$base\" | tr '[:upper:]' '[:lower:]')\" = \"$(echo '{enc}' | tr '[:upper:]' '[:lower:]')\" ] && [ \"$base\" != '{enc}' ]; then \
                 find \"$d\" -maxdepth 1 -name '*.jsonl' -mmin -{mmin} 2>/dev/null | xargs -r ls -1t 2>/dev/null | sed 's|.*/||;s|\\.jsonl$||'; \
               fi; \
             done",
            enc = encoded, mmin = mmin_val
        )
    } else {
        format!(
            "ls -1t ~/.claude/projects/{}/*.jsonl 2>/dev/null | sed 's|.*/||;s|\\.jsonl$||'; \
             for d in ~/.claude/projects/*/; do \
               base=$(basename \"$d\"); \
               if [ \"$(echo \"$base\" | tr '[:upper:]' '[:lower:]')\" = \"$(echo '{}' | tr '[:upper:]' '[:lower:]')\" ] && [ \"$base\" != '{}' ]; then \
                 ls -1t \"$d\"*.jsonl 2>/dev/null | sed 's|.*/||;s|\\.jsonl$||'; \
               fi; \
             done",
            encoded, encoded, encoded
        )
    };

    let output = wsl_command()
        .args(["--", "bash", "-lic", &script])
        .output()
        .map_err(|e| format!("Failed to query Claude sessions: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();

    if stdout.is_empty() {
        return Ok(None);
    }

    let is_valid_uuid = |s: &str| -> bool {
        s.len() == 36
            && s.split('-').count() == 5
            && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
    };

    // Return the first valid UUID that isn't in the exclude list
    // (exact-match results come first, then case-insensitive fallback)
    for line in stdout.lines() {
        let id = line.trim();
        if is_valid_uuid(id) && !exclude_ids.iter().any(|ex| ex == id) {
            return Ok(Some(id.to_string()));
        }
    }

    Ok(None)
}

/// Find the most recent Codex session ID for a given project.
/// Codex ≥0.113 stores sessions in ~/.codex/state_5.sqlite `threads` table.
/// Falls back to JSONL file scanning for older versions.
#[tauri::command]
async fn get_codex_session_id(project_path: String, exclude_ids: Vec<String>) -> Result<Option<String>, String> {
    let is_valid_uuid = |s: &str| -> bool {
        s.len() == 36
            && s.split('-').count() == 5
            && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
    };

    // Primary: query SQLite threads table (Codex ≥0.113).
    // Try both the exact path and case-insensitive match for /mnt/c paths.
    let exclude_csv = exclude_ids.join(",");
    let script = format!(
        r#"python3 -c "
import sqlite3, os, sys
db = os.path.expanduser('~/.codex/state_5.sqlite')
if not os.path.exists(db):
    sys.exit(0)
c = sqlite3.connect(db)
exclude = set(sys.argv[1].split(',')) if sys.argv[1] else set()
path = sys.argv[2]
rows = c.execute('SELECT id FROM threads WHERE cwd=? ORDER BY updated_at DESC LIMIT 20', (path,)).fetchall()
if not rows and path.startswith('/mnt/'):
    rows = c.execute('SELECT id, cwd FROM threads ORDER BY updated_at DESC LIMIT 50').fetchall()
    rows = [(r[0],) for r in rows if r[1].lower() == path.lower()]
for r in rows:
    if r[0] not in exclude:
        print(r[0])
        break
" '{}' '{}'"#,
        exclude_csv.replace('\'', "'\\''"),
        project_path.replace('\'', "'\\''")
    );

    let output = wsl_command()
        .args(["--", "bash", "-lic", &script])
        .output()
        .map_err(|e| format!("Failed to query Codex sessions: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stdout.is_empty() {
        for line in stdout.lines() {
            let id = line.trim();
            if is_valid_uuid(id) {
                return Ok(Some(id.to_string()));
            }
        }
    }

    // Fallback: scan JSONL files (Codex <0.113)
    let fallback_script = format!(
        "find ~/.codex/sessions -name '*.jsonl' -type f 2>/dev/null | xargs ls -1t 2>/dev/null | head -20 | xargs -I{{}} head -1 {{}} 2>/dev/null | grep -i '\"cwd\":\"{}\"' | grep -oE '\"id\":\"[0-9a-f]{{8}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{12}}\"' | sed 's/\"id\":\"//;s/\"//'",
        project_path.replace('\'', "'\\''")
    );

    let output = wsl_command()
        .args(["--", "bash", "-lic", &fallback_script])
        .output()
        .map_err(|e| format!("Failed to query Codex sessions (fallback): {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    for line in stdout.lines() {
        let id = line.trim();
        if is_valid_uuid(id) && !exclude_ids.iter().any(|ex| ex == id) {
            return Ok(Some(id.to_string()));
        }
    }

    Ok(None)
}

/// Find the most recent Gemini session ID for a given project.
/// Gemini stores sessions at ~/.gemini/tmp/<project_name>/chats/session-<ts>-<partial_uuid>.json
/// where <project_name> is the lowercased directory basename (with optional -N suffix for collisions).
/// The JSON is pretty-printed; "sessionId" is on line 2.
#[tauri::command]
async fn get_gemini_session_id(project_path: String, exclude_ids: Vec<String>) -> Result<Option<String>, String> {
    // Extract the basename of the project path and lowercase it to match Gemini's folder naming.
    let basename = project_path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_lowercase();

    // Search matching project folders (exact + suffixed variants like "project-1", "project-2").
    // Falls back to all projects if basename is empty.
    let script = if basename.is_empty() {
        "ls -1t ~/.gemini/tmp/*/chats/*.json 2>/dev/null | head -20 | xargs grep -h sessionId 2>/dev/null | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'".to_string()
    } else {
        format!(
            "ls -1t ~/.gemini/tmp/{{{},{}-[0-9]*}}/chats/*.json 2>/dev/null | head -20 | xargs grep -h sessionId 2>/dev/null | grep -oE '[0-9a-f]{{8}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{12}}'",
            basename, basename
        )
    };

    let output = wsl_command()
        .args(["--", "bash", "-lic", &script])
        .output()
        .map_err(|e| format!("Failed to query Gemini sessions: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        return Ok(None);
    }

    let is_valid_uuid = |s: &str| -> bool {
        s.len() == 36
            && s.split('-').count() == 5
            && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
    };

    for line in stdout.lines() {
        let id = line.trim();
        if is_valid_uuid(id) && !exclude_ids.iter().any(|ex| ex == id) {
            return Ok(Some(id.to_string()));
        }
    }

    Ok(None)
}

/// Resolve CLI paths on native Windows using `where.exe`.
/// Returns a BTreeMap<String, String> with cli_name → resolved_path entries.
#[tauri::command]
async fn windows_resolve_cli_env(cli_names: Vec<String>) -> Result<std::collections::BTreeMap<String, String>, String> {
    let mut result = std::collections::BTreeMap::new();

    for name in &cli_names {
        // where.exe finds executables on the Windows PATH
        let output = Command::new("where.exe")
            .arg(name)
            .output()
            .map_err(|e| format!("Failed to run where.exe for {}: {}", name, e))?;

        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            // where.exe may return multiple lines — take the first match
            if let Some(first_line) = stdout.lines().next() {
                let path = first_line.trim();
                if !path.is_empty() {
                    result.insert(name.clone(), path.to_string());
                }
            }
        }
    }

    Ok(result)
}

/// Find the most recent Claude session ID on native Windows.
/// Claude stores sessions at %USERPROFILE%\.claude\projects\<encoded-path>\<uuid>.jsonl
#[tauri::command]
async fn get_claude_session_id_windows(project_path: String, exclude_ids: Vec<String>, max_age_secs: Option<u64>) -> Result<Option<String>, String> {
    let home = std::env::var("USERPROFILE").map_err(|_| "USERPROFILE not set".to_string())?;
    let encoded = project_path.replace('\\', "-").replace('/', "-");
    // Strip leading dash if present (from paths starting with C:\)
    let encoded = encoded.trim_start_matches('-').to_string();
    let session_dir = std::path::Path::new(&home).join(".claude").join("projects").join(&encoded);

    if !session_dir.exists() {
        return Ok(None);
    }

    let is_valid_uuid = |s: &str| -> bool {
        s.len() == 36
            && s.split('-').count() == 5
            && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
    };

    let now = std::time::SystemTime::now();

    // Read directory entries sorted by modification time (newest first)
    let mut entries: Vec<_> = std::fs::read_dir(&session_dir)
        .map_err(|e| format!("Failed to read session dir: {}", e))?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map_or(false, |ext| ext == "jsonl"))
        .filter_map(|e| {
            let mtime = e.metadata().ok()?.modified().ok()?;
            // Apply recency filter: skip files older than max_age_secs
            if let Some(max_age) = max_age_secs {
                if let Ok(age) = now.duration_since(mtime) {
                    if age.as_secs() > max_age {
                        return None;
                    }
                }
            }
            Some((e, mtime))
        })
        .collect();
    entries.sort_by(|a, b| b.1.cmp(&a.1));

    for (entry, _) in entries {
        if let Some(stem) = entry.path().file_stem().and_then(|s| s.to_str()) {
            if is_valid_uuid(stem) && !exclude_ids.iter().any(|ex| ex == stem) {
                return Ok(Some(stem.to_string()));
            }
        }
    }

    Ok(None)
}

/// Find the most recent Codex session ID on native Windows.
/// Codex ≥0.113 stores sessions in %USERPROFILE%\.codex\state_5.sqlite `threads` table.
/// Falls back to JSONL file scanning for older versions.
#[tauri::command]
async fn get_codex_session_id_windows(project_path: String, exclude_ids: Vec<String>) -> Result<Option<String>, String> {
    let home = std::env::var("USERPROFILE").map_err(|_| "USERPROFILE not set".to_string())?;
    let codex_dir = std::path::Path::new(&home).join(".codex");

    let is_valid_uuid = |s: &str| -> bool {
        s.len() == 36
            && s.split('-').count() == 5
            && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
    };

    // Primary: query SQLite threads table (Codex ≥0.113)
    let db_path = codex_dir.join("state_5.sqlite");
    if db_path.exists() {
        let exclude_csv = exclude_ids.join(",");
        let py_script = format!(
            r#"import sqlite3,sys;c=sqlite3.connect(r'{}');exclude=set(sys.argv[1].split(',')) if sys.argv[1] else set();path=sys.argv[2];rows=c.execute('SELECT id FROM threads WHERE cwd=? ORDER BY updated_at DESC LIMIT 20',(path,)).fetchall();
[print(r[0]) or sys.exit(0) for r in rows if r[0] not in exclude]"#,
            db_path.display()
        );
        // Try python3 first, then python (Windows often has "python" not "python3")
        let output = Command::new("python3")
            .args(["-c", &py_script, &exclude_csv, &project_path])
            .output()
            .or_else(|_| Command::new("python")
                .args(["-c", &py_script, &exclude_csv, &project_path])
                .output()
            );
        if let Ok(o) = output {
            let stdout = String::from_utf8_lossy(&o.stdout).trim().to_string();
            for line in stdout.lines() {
                let id = line.trim();
                if is_valid_uuid(id) {
                    return Ok(Some(id.to_string()));
                }
            }
        }
    }

    // Fallback: scan JSONL files (Codex <0.113)
    let sessions_dir = codex_dir.join("sessions");
    if !sessions_dir.exists() {
        return Ok(None);
    }

    let mut files: Vec<(std::path::PathBuf, std::time::SystemTime)> = Vec::new();
    fn walk_dir(dir: &std::path::Path, files: &mut Vec<(std::path::PathBuf, std::time::SystemTime)>) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let path = entry.path();
                if path.is_dir() {
                    walk_dir(&path, files);
                } else if path.extension().map_or(false, |ext| ext == "jsonl") {
                    if let Ok(meta) = entry.metadata() {
                        if let Ok(mtime) = meta.modified() {
                            files.push((path, mtime));
                        }
                    }
                }
            }
        }
    }
    walk_dir(&sessions_dir, &mut files);
    files.sort_by(|a, b| b.1.cmp(&a.1));

    for (path, _) in files.iter().take(20) {
        if let Ok(file) = std::fs::File::open(path) {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(file);
            if let Some(Ok(first_line)) = reader.lines().next() {
                let cwd_match = format!("\"cwd\":\"{}\"", project_path);
                let cwd_match_spaced = format!("\"cwd\": \"{}\"", project_path);
                if !first_line.contains(&cwd_match) && !first_line.contains(&cwd_match_spaced) {
                    continue;
                }
                if let Some(id_start) = first_line.find("\"id\":\"").or_else(|| first_line.find("\"id\": \"")) {
                    let after = &first_line[id_start..];
                    if let Some(uuid_start) = after.find('"').and_then(|i| after[i+1..].find('"').map(|j| i + 1 + j + 1)) {
                        let remaining = &after[uuid_start..];
                        if let Some(end) = remaining.find('"') {
                            let id = &remaining[..end];
                            if is_valid_uuid(id) && !exclude_ids.iter().any(|ex| ex == id) {
                                return Ok(Some(id.to_string()));
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(None)
}

/// Find the most recent Gemini session ID on native Windows.
/// Gemini stores sessions at %USERPROFILE%\.gemini\tmp\<project>\chats\session-*.json
#[tauri::command]
async fn get_gemini_session_id_windows(project_path: String, exclude_ids: Vec<String>) -> Result<Option<String>, String> {
    let home = std::env::var("USERPROFILE").map_err(|_| "USERPROFILE not set".to_string())?;
    let tmp_dir = std::path::Path::new(&home).join(".gemini").join("tmp");

    if !tmp_dir.exists() {
        return Ok(None);
    }

    // Extract the basename and lowercase it to match Gemini's folder naming
    let basename = project_path
        .trim_end_matches('\\')
        .trim_end_matches('/')
        .rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or("")
        .to_lowercase();

    let is_valid_uuid = |s: &str| -> bool {
        s.len() == 36
            && s.split('-').count() == 5
            && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
    };

    // Find session JSON files only in matching project subdirs (exact + suffixed)
    let mut files: Vec<(std::path::PathBuf, std::time::SystemTime)> = Vec::new();
    if let Ok(projects) = std::fs::read_dir(&tmp_dir) {
        for proj in projects.filter_map(|e| e.ok()) {
            // Filter by project name — match exact basename or basename-N variants
            if !basename.is_empty() {
                let dir_name = proj.file_name().to_string_lossy().to_lowercase();
                if dir_name != basename && !dir_name.starts_with(&format!("{}-", basename)) {
                    continue;
                }
            }
            let chats_dir = proj.path().join("chats");
            if chats_dir.is_dir() {
                if let Ok(entries) = std::fs::read_dir(&chats_dir) {
                    for entry in entries.filter_map(|e| e.ok()) {
                        let path = entry.path();
                        if path.extension().map_or(false, |ext| ext == "json") {
                            if let Ok(meta) = entry.metadata() {
                                if let Ok(mtime) = meta.modified() {
                                    files.push((path, mtime));
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    files.sort_by(|a, b| b.1.cmp(&a.1));

    // Read sessionId from each file (line 2 in pretty-printed JSON)
    for (path, _) in files.iter().take(20) {
        if let Ok(content) = std::fs::read_to_string(path) {
            // Search for sessionId in the content
            if let Some(idx) = content.find("\"sessionId\"") {
                let after = &content[idx..];
                // Extract UUID after the colon
                let uuid_re_like = |s: &str| -> Option<String> {
                    // Find first UUID-like pattern
                    let chars: Vec<char> = s.chars().collect();
                    let mut i = 0;
                    while i < chars.len() {
                        if chars[i] == '"' {
                            let start = i + 1;
                            if let Some(end_pos) = s[start..].find('"') {
                                let candidate = &s[start..start + end_pos];
                                if is_valid_uuid(candidate) {
                                    return Some(candidate.to_string());
                                }
                            }
                        }
                        i += 1;
                    }
                    None
                };
                if let Some(id) = uuid_re_like(after) {
                    if !exclude_ids.iter().any(|ex| *ex == id) {
                        return Ok(Some(id));
                    }
                }
            }
        }
    }

    Ok(None)
}

/// Read context info from CLI session files on native Windows.
/// Uses Rust-native JSON parsing (no jq dependency).
#[tauri::command]
async fn read_session_context_windows(
    terminal_type: String,
    session_id: String,
) -> Result<String, String> {
    if session_id.is_empty() {
        return Ok(String::new());
    }
    let home = std::env::var("USERPROFILE").map_err(|_| "USERPROFILE not set".to_string())?;
    let is_latest = session_id == "__latest__";

    match terminal_type.as_str() {
        "claude" => {
            // Read statusline JSON if available
            let sl_path = std::path::Path::new(&home).join(".ezydev").join("claude-statusline.json");
            let mut sl_window: Option<u64> = None;
            let mut sl_model: Option<String> = None;
            let mut sl_used_pct: Option<u64> = None;
            let mut sl_cost: Option<f64> = None;
            let mut sl_duration: Option<u64> = None;
            let mut sl_version: Option<String> = None;
            let mut sl_session_id: Option<String> = None;
            if let Ok(content) = std::fs::read_to_string(&sl_path) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                    sl_window = v.pointer("/context_window/context_window_size").and_then(|v| v.as_u64());
                    sl_model = v.pointer("/model/display_name").and_then(|v| v.as_str()).map(|s| s.to_string());
                    sl_used_pct = v.pointer("/context_window/used_percentage").and_then(|v| v.as_u64());
                    sl_cost = v.pointer("/cost/total_cost_usd").and_then(|v| v.as_f64());
                    sl_duration = v.pointer("/cost/total_duration_ms").and_then(|v| v.as_u64());
                    sl_version = v.pointer("/version").and_then(|v| v.as_str()).map(|s| s.to_string());
                    sl_session_id = v.pointer("/session_id").and_then(|v| v.as_str()).map(|s| s.to_string());
                    // Cache per-session cost from statusline
                    if let (Some(ref sid), Some(cost)) = (&sl_session_id, sl_cost) {
                        let cache_path = std::env::temp_dir().join(format!("ezydev-claude-cost-{}.txt", sid));
                        let dur_str = sl_duration.map(|d| d.to_string()).unwrap_or_default();
                        let _ = std::fs::write(&cache_path, format!("{:.6}|{}", cost, dur_str));
                    }
                }
            }

            let used_pct_str = sl_used_pct.map(|v| v.to_string()).unwrap_or_default();
            let ver_str = sl_version.unwrap_or_default();

            // Read effortLevel from ~/.claude/settings.json
            let effort_level: String = {
                let settings_path = std::path::Path::new(&home).join(".claude").join("settings.json");
                std::fs::read_to_string(&settings_path).ok()
                    .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
                    .and_then(|v| v.get("effortLevel").and_then(|v| v.as_str()).map(|s| s.to_string()))
                    .unwrap_or_default()
            };

            if is_latest {
                // 0|window|model|used_pct|||version|||||effort
                if let Some(w) = sl_window {
                    return Ok(format!("0|{}|{}|{}|||{}|||||{}", w, sl_model.as_deref().unwrap_or(""), used_pct_str, ver_str, effort_level));
                }
                return Ok(String::new());
            }

            // Find session file
            let claude_dir = std::path::Path::new(&home).join(".claude").join("projects");
            let mut session_file: Option<std::path::PathBuf> = None;
            if claude_dir.exists() {
                // Walk project dirs to find <uuid>.jsonl
                if let Ok(projects) = std::fs::read_dir(&claude_dir) {
                    for proj in projects.filter_map(|e| e.ok()) {
                        let candidate = proj.path().join(format!("{}.jsonl", session_id));
                        if candidate.exists() {
                            session_file = Some(candidate);
                            break;
                        }
                    }
                }
            }

            let f = match session_file {
                Some(f) => f,
                None => return Ok(String::new()),
            };

            // Read last usage line + extract service_tier/speed
            let content = std::fs::read_to_string(&f).map_err(|e| e.to_string())?;
            let mut total: u64 = 0;
            let mut service_tier = String::new();
            let mut speed = String::new();
            for line in content.lines().rev() {
                if line.contains("\"message\"") && line.contains("\"usage\"") {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                        if let Some(usage) = v.pointer("/message/usage") {
                            let input = usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                            let cache_create = usage.get("cache_creation_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                            let cache_read = usage.get("cache_read_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                            let output = usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                            total = input + cache_create + cache_read + output;
                            if let Some(st) = usage.get("service_tier").and_then(|v| v.as_str()) {
                                service_tier = st.to_string();
                            }
                            if let Some(sp) = usage.get("speed").and_then(|v| v.as_str()) {
                                speed = sp.to_string();
                            }
                            break;
                        }
                    }
                }
            }

            // Count context compactions + extract custom title
            let compact_count = content.lines().filter(|l| l.contains("compact_boundary")).count();
            let mut custom_title = String::new();
            for line in content.lines().rev() {
                if line.contains("\"custom-title\"") {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                        if let Some(t) = v.get("customTitle").and_then(|v| v.as_str()) {
                            custom_title = t.to_string();
                            break;
                        }
                    }
                }
            }

            // Per-session cost: use statusline if session matches, else cached
            let (sess_cost, sess_duration): (Option<f64>, Option<u64>) =
                if sl_session_id.as_deref() == Some(&session_id) {
                    (sl_cost, sl_duration)
                } else {
                    let cache_path = std::env::temp_dir().join(format!("ezydev-claude-cost-{}.txt", session_id));
                    if let Ok(cached) = std::fs::read_to_string(&cache_path) {
                        let parts: Vec<&str> = cached.trim().split('|').collect();
                        let c = parts.first().and_then(|s| s.parse::<f64>().ok());
                        let d = parts.get(1).and_then(|s| s.parse::<u64>().ok());
                        (c, d)
                    } else {
                        (None, None)
                    }
                };

            // Project cost: sum all cached session costs in the project directory
            let proj_cost: Option<f64> = {
                let proj_dir = f.parent();
                if let Some(dir) = proj_dir {
                    let mut total_cost: f64 = 0.0;
                    let mut found_any = false;
                    if let Ok(entries) = std::fs::read_dir(dir) {
                        for entry in entries.filter_map(|e| e.ok()) {
                            let path = entry.path();
                            if path.extension().map_or(true, |ext| ext != "jsonl") { continue; }
                            let sid = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                            let sc = if sl_session_id.as_deref() == Some(&sid) {
                                sl_cost
                            } else {
                                let cp = std::env::temp_dir().join(format!("ezydev-claude-cost-{}.txt", sid));
                                std::fs::read_to_string(&cp).ok()
                                    .and_then(|c| c.trim().split('|').next().and_then(|s| s.parse::<f64>().ok()))
                            };
                            if let Some(c) = sc { total_cost += c; found_any = true; }
                        }
                    }
                    if found_any { Some(total_cost) } else { None }
                } else { None }
            };

            let cost_str = sess_cost.map(|c| format!("{:.6}", c)).unwrap_or_default();
            let dur_str = sess_duration.map(|d| d.to_string()).unwrap_or_default();
            let proj_str = proj_cost.map(|c| format!("{:.6}", c)).unwrap_or_default();

            if total == 0 {
                if let Some(w) = sl_window {
                    // 0|window|model|used_pct|cost|dur|version|||compact|proj|effort|custom_title
                    return Ok(format!("0|{}|{}|{}|{}|{}|{}|||{}|{}|{}|{}", w, sl_model.as_deref().unwrap_or(""), used_pct_str, cost_str, dur_str, ver_str, compact_count, proj_str, effort_level, custom_title));
                }
                return Ok(String::new());
            }

            let window = sl_window.unwrap_or(200000);
            let model_str = sl_model.unwrap_or_default();
            // total|window|model|used_pct|cost|dur|version|tier|speed|compact|proj|effort|custom_title
            Ok(format!("{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}", total, window, model_str, used_pct_str, cost_str, dur_str, ver_str, service_tier, speed, compact_count, proj_str, effort_level, custom_title))
        },
        "codex" => {
            let sessions_dir = std::path::Path::new(&home).join(".codex").join("sessions");
            if !sessions_dir.exists() {
                return Ok(String::new());
            }

            // Find session file
            let target_file: Option<std::path::PathBuf>;
            if is_latest {
                // Find most recent .jsonl file
                let mut files: Vec<(std::path::PathBuf, std::time::SystemTime)> = Vec::new();
                fn walk(dir: &std::path::Path, files: &mut Vec<(std::path::PathBuf, std::time::SystemTime)>) {
                    if let Ok(entries) = std::fs::read_dir(dir) {
                        for entry in entries.filter_map(|e| e.ok()) {
                            let path = entry.path();
                            if path.is_dir() { walk(&path, files); }
                            else if path.extension().map_or(false, |ext| ext == "jsonl") {
                                if let Ok(m) = entry.metadata() {
                                    if let Ok(t) = m.modified() { files.push((path, t)); }
                                }
                            }
                        }
                    }
                }
                walk(&sessions_dir, &mut files);
                files.sort_by(|a, b| b.1.cmp(&a.1));
                target_file = files.into_iter().next().map(|(p, _)| p);
            } else {
                // Search for file containing the session UUID
                fn walk2(dir: &std::path::Path, uuid: &str) -> Option<std::path::PathBuf> {
                    if let Ok(entries) = std::fs::read_dir(dir) {
                        for entry in entries.filter_map(|e| e.ok()) {
                            let path = entry.path();
                            if path.is_dir() {
                                if let Some(found) = walk2(&path, uuid) { return Some(found); }
                            } else if path.file_name().map_or(false, |n| n.to_string_lossy().contains(uuid)) {
                                return Some(path);
                            }
                        }
                    }
                    None
                }
                target_file = walk2(&sessions_dir, &session_id);
            }

            let f = match target_file {
                Some(f) => f,
                None => return Ok(String::new()),
            };

            let content = std::fs::read_to_string(&f).map_err(|e| e.to_string())?;
            let mut used: Option<u64> = None;
            let mut window: Option<u64> = None;
            let mut model: String = String::new();
            let mut effort: String = String::new();
            let mut collab_mode: String = String::new();

            for line in content.lines().rev() {
                if window.is_some() && (used.is_some() || is_latest) { break; }
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                    if window.is_none() {
                        if let Some(w) = v.pointer("/payload/info/model_context_window").and_then(|v| v.as_u64()) {
                            if w > 0 { window = Some(w); }
                        }
                        if used.is_none() && !is_latest {
                            if let Some(u) = v.pointer("/payload/info/last_token_usage/total_tokens").and_then(|v| v.as_u64()) {
                                if u > 0 { used = Some(u); }
                            }
                        }
                    }
                    if model.is_empty() {
                        if let Some(m) = v.pointer("/payload/model").and_then(|v| v.as_str()) {
                            model = m.to_string();
                        }
                    }
                    if effort.is_empty() {
                        if let Some(e) = v.pointer("/payload/effort").and_then(|v| v.as_str()) {
                            effort = e.to_string();
                        }
                    }
                    if collab_mode.is_empty() {
                        if let Some(cm) = v.pointer("/payload/collaboration_mode/mode").and_then(|v| v.as_str()) {
                            collab_mode = cm.to_string();
                        }
                    }
                }
            }

            if is_latest { used = None; }
            let used_val = used.unwrap_or(0);
            let window_val = match window {
                Some(w) => w,
                None => return Ok(String::new()),
            };

            // Rate limits: account-level — search all sessions (newest first)
            let mut rl5h: Option<f64> = None;
            let mut rlweek: Option<f64> = None;
            {
                // Collect all session files sorted by mtime (newest first)
                let mut all_files: Vec<(std::path::PathBuf, std::time::SystemTime)> = Vec::new();
                fn walk_rl(dir: &std::path::Path, files: &mut Vec<(std::path::PathBuf, std::time::SystemTime)>) {
                    if let Ok(entries) = std::fs::read_dir(dir) {
                        for entry in entries.filter_map(|e| e.ok()) {
                            let path = entry.path();
                            if path.is_dir() { walk_rl(&path, files); }
                            else if path.extension().map_or(false, |ext| ext == "jsonl") {
                                if let Ok(m) = entry.metadata() {
                                    if let Ok(t) = m.modified() { files.push((path, t)); }
                                }
                            }
                        }
                    }
                }
                walk_rl(&sessions_dir, &mut all_files);
                all_files.sort_by(|a, b| b.1.cmp(&a.1));
                for (rf, _) in all_files.iter().take(15) {
                    if let Ok(rc) = std::fs::read_to_string(rf) {
                        for line in rc.lines().rev() {
                            if !line.contains("\"rate_limits\"") || line.contains("\"rate_limits\":null") { continue; }
                            if !line.contains("\"used_percent\"") { continue; }
                            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                                rl5h = v.pointer("/payload/rate_limits/primary/used_percent").and_then(|v| v.as_f64());
                                rlweek = v.pointer("/payload/rate_limits/secondary/used_percent").and_then(|v| v.as_f64());
                                break;
                            }
                        }
                    }
                    if rl5h.is_some() { break; }
                }
            }
            let rl5h_str = rl5h.map(|v| format!("{:.2}", v)).unwrap_or_default();
            let rlweek_str = rlweek.map(|v| format!("{:.2}", v)).unwrap_or_default();

            // Read session title from SQLite
            let mut title = String::new();
            if !is_latest {
                let db_path = std::path::Path::new(&home).join(".codex").join("state_5.sqlite");
                if db_path.exists() {
                    let py = format!(
                        r#"import sqlite3,sys;c=sqlite3.connect(r'{}');r=c.execute('SELECT title FROM threads WHERE id=?',(sys.argv[1],)).fetchone();print(r[0] if r else '')"#,
                        db_path.display()
                    );
                    if let Ok(out) = std::process::Command::new("python3").args(["-c", &py, &session_id]).output() {
                        title = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    }
                }
            }

            Ok(format!("{}|{}|{}|{}|{}|{}|{}|{}", used_val, window_val, model, rl5h_str, rlweek_str, effort, collab_mode, title))
        },
        "gemini" => {
            let tmp_dir = std::path::Path::new(&home).join(".gemini").join("tmp");
            if !tmp_dir.exists() {
                return Ok(String::new());
            }

            // Find most recent session file
            let mut files: Vec<(std::path::PathBuf, std::time::SystemTime)> = Vec::new();
            if let Ok(projects) = std::fs::read_dir(&tmp_dir) {
                for proj in projects.filter_map(|e| e.ok()) {
                    let chats = proj.path().join("chats");
                    if chats.is_dir() {
                        if let Ok(entries) = std::fs::read_dir(&chats) {
                            for entry in entries.filter_map(|e| e.ok()) {
                                let path = entry.path();
                                if path.extension().map_or(false, |ext| ext == "json") {
                                    if let Ok(m) = entry.metadata() {
                                        if let Ok(t) = m.modified() { files.push((path, t)); }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            files.sort_by(|a, b| b.1.cmp(&a.1));

            let f = match files.into_iter().next() {
                Some((p, _)) => p,
                None => return Ok(String::new()),
            };

            let content = std::fs::read_to_string(&f).map_err(|e| e.to_string())?;
            let v: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;

            // Last message input tokens
            let inp = v.pointer("/messages")
                .and_then(|m| m.as_array())
                .map(|msgs| msgs.iter().rev().find_map(|m| m.pointer("/tokens/input").and_then(|v| v.as_u64())).unwrap_or(0))
                .unwrap_or(0);
            if inp == 0 { return Ok(String::new()); }

            // Last model
            let model = v.pointer("/messages")
                .and_then(|m| m.as_array())
                .map(|msgs| msgs.iter().rev().find_map(|m| m.get("model").and_then(|v| v.as_str())).unwrap_or(""))
                .unwrap_or("");

            // Summary
            let summary = v.get("summary").and_then(|v| v.as_str()).unwrap_or("");

            // Last thinking tokens
            let thoughts = v.pointer("/messages")
                .and_then(|m| m.as_array())
                .map(|msgs| msgs.iter().rev().find_map(|m| m.pointer("/tokens/thoughts").and_then(|v| v.as_u64())).unwrap_or(0))
                .unwrap_or(0);

            Ok(format!("{}|1000000|{}||{}|{}|", inp, model, summary, thoughts))
        },
        _ => Ok(String::new()),
    }
}

#[tauri::command]
fn set_window_corners(window: tauri::WebviewWindow, rounded: bool) -> Result<(), String> {
    let _ = (&window, rounded);
    #[cfg(target_os = "windows")]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        win32_border::set_corner_preference(hwnd.0, rounded);
    }
    Ok(())
}

/// Install the EzyDev statusline wrapper in WSL.
/// Creates ~/.ezydev/statusline-wrapper.sh that saves the raw statusline JSON
/// to /tmp/ezydev-claude-statusline.json and chains to the user's existing
/// statusline command (e.g. cc-statusline) so it keeps working.
#[tauri::command]
async fn install_statusline_wrapper(distro: Option<String>) -> Result<String, String> {
    let wrapper_script = r#"#!/bin/bash
input=$(cat)
# Save raw statusline JSON for EzyDev to read
echo "$input" > /tmp/ezydev-claude-statusline.json 2>/dev/null
# Chain to original statusline command (e.g. cc-statusline)
_chain="$(cat "$HOME/.ezydev/statusline-chain" 2>/dev/null)"
# Guard: never chain to ourselves (prevents infinite recursion / fork bomb)
case "$_chain" in *statusline-wrapper*) _chain="" ;; esac
if [ -n "$_chain" ] && [ -x "$_chain" ]; then
  echo "$input" | "$_chain"
else
  echo "$input"
fi
"#;

    // Base64-encode the wrapper to avoid heredoc expansion issues in bash -lic
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(wrapper_script.trim());

    // Single bash script: check if installed, create dir, write wrapper, save chain, update settings
    let script = format!(
        r#"
WRAPPER="$HOME/.ezydev/statusline-wrapper.sh"
CHAIN_FILE="$HOME/.ezydev/statusline-chain"
SETTINGS="$HOME/.claude/settings.json"

# Read current statusline command from settings
CURRENT=""
if [ -f "$SETTINGS" ] && command -v jq >/dev/null 2>&1; then
  CURRENT=$(jq -r '.statusLine.command // ""' "$SETTINGS" 2>/dev/null || true)
fi

mkdir -p "$HOME/.ezydev" 2>/dev/null

# Always (re)write wrapper script (base64-encoded to avoid heredoc expansion issues)
echo "{b64}" | base64 -d > "$WRAPPER"
chmod +x "$WRAPPER" 2>/dev/null || true

# Save original statusline command as chain target (only if not already pointing to wrapper)
case "$CURRENT" in
  *statusline-wrapper*) ;;  # Already ours, don't overwrite chain
  *)
    if [ -n "$CURRENT" ]; then
      EXPANDED=$(eval echo "$CURRENT" 2>/dev/null || echo "$CURRENT")
      echo "$EXPANDED" > "$CHAIN_FILE"
    fi
    ;;
esac

# Update settings.json (only if not already pointing to wrapper)
case "$CURRENT" in
  *statusline-wrapper*)
    echo "UPDATED_WRAPPER"
    exit 0
    ;;
esac

if [ -f "$SETTINGS" ] && command -v jq >/dev/null 2>&1; then
  TMP=$(mktemp)
  if jq '.statusLine = {{"type": "command", "command": "~/.ezydev/statusline-wrapper.sh"}}' "$SETTINGS" > "$TMP" 2>/dev/null; then
    mv "$TMP" "$SETTINGS"
  else
    rm -f "$TMP"
    echo "ERR_JQ_UPDATE"
    exit 1
  fi
fi

echo "INSTALLED"
"#,
        b64 = b64
    );

    // On macOS/Linux (no distro param), run bash directly.
    // On Windows (with or without distro), pipe through wsl.exe.
    #[cfg(not(target_os = "windows"))]
    let mut child = {
        let _ = &distro; // unused on non-Windows
        Command::new("bash")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn bash: {}", e))?
    };

    #[cfg(target_os = "windows")]
    let mut child = {
        let mut args = Vec::new();
        if let Some(ref d) = distro {
            args.push("-d".to_string());
            args.push(d.clone());
        }
        args.extend(["--".to_string(), "bash".to_string()]);
        wsl_command()
            .args(&args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn wsl: {}", e))?
    };

    if let Some(ref mut stdin) = child.stdin {
        use std::io::Write;
        let _ = stdin.write_all(script.as_bytes());
    }
    drop(child.stdin.take()); // Close stdin to signal EOF

    let output = child.wait_with_output()
        .map_err(|e| format!("Failed to wait for shell: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if stdout.is_empty() && !stderr.is_empty() {
        return Ok(format!("ERR: {}", stderr));
    }
    if stdout.is_empty() {
        return Ok(format!("ERR_EMPTY (exit={})", output.status.code().unwrap_or(-1)));
    }
    Ok(stdout)
}

/// Read context percentage from CLI session JSONL files.
/// Supports Claude (usage per message) and Codex (token_count events).
/// Returns the percentage remaining as a string ("0"-"100"), or empty string if not available.
///
/// Uses a temp-file cache (/tmp/ezydev-sessionpath-{session_id}) to avoid repeated `find` calls.
#[tauri::command]
async fn read_session_context(
    terminal_type: String,
    session_id: String,
    distro: Option<String>,
) -> Result<String, String> {
    if session_id.is_empty() {
        return Ok(String::new());
    }
    // "__latest__" = no specific session yet, search all recent sessions
    let is_latest = session_id == "__latest__";

    // Build a bash script that:
    // 1. Locates the session file (cached after first lookup)
    // 2. Reads the last usage/token_count entry
    // 3. Calculates remaining context percentage
    let script = match terminal_type.as_str() {
        "claude" => format!(
            r#"
command -v jq >/dev/null 2>&1 || exit 0

# Read effortLevel from ~/.claude/settings.json
effort_level=""
SETTINGS="$HOME/.claude/settings.json"
if [ -f "$SETTINGS" ]; then
  effort_level=$(jq -r '.effortLevel // empty' "$SETTINGS" 2>/dev/null)
fi

# Read statusline JSON (if available)
SL="/tmp/ezydev-claude-statusline.json"
sl_window=""
sl_model=""
sl_used_pct=""
sl_cost=""
sl_duration=""
sl_version=""
sl_session_id=""
if [ -f "$SL" ]; then
  sl_window=$(jq -r '.context_window.context_window_size // empty' "$SL" 2>/dev/null)
  sl_model=$(jq -r '.model.display_name // empty' "$SL" 2>/dev/null)
  sl_used_pct=$(jq -r '.context_window.used_percentage // empty' "$SL" 2>/dev/null)
  sl_cost=$(jq -r '.cost.total_cost_usd // empty' "$SL" 2>/dev/null)
  sl_duration=$(jq -r '.cost.total_duration_ms // empty' "$SL" 2>/dev/null)
  sl_version=$(jq -r '.version // empty' "$SL" 2>/dev/null)
  sl_session_id=$(jq -r '.session_id // empty' "$SL" 2>/dev/null)
  # Cache per-session cost from statusline
  if [ -n "$sl_session_id" ] && [ -n "$sl_cost" ]; then
    echo "$sl_cost|$sl_duration" > "/tmp/ezydev-claude-cost-$sl_session_id.txt"
  fi
fi

# Read precise token counts from JSONL session file
SID='{session_id}'
if [ "$SID" = "__latest__" ]; then
  # No specific session (new pane) — no per-session cost yet.
  if [ -n "$sl_window" ]; then
    echo "0|$sl_window|$sl_model|$sl_used_pct|||$sl_version|||||$effort_level"
  fi
  exit 0
else
  CACHE="/tmp/ezydev-sessionpath-$SID"
  if [ -f "$CACHE" ]; then
    f=$(cat "$CACHE")
    [ ! -f "$f" ] && rm -f "$CACHE" && f=""
  fi
  if [ -z "$f" ]; then
    f=$(find ~/.claude/projects/ -name "$SID.jsonl" -type f 2>/dev/null | head -1)
    [ -n "$f" ] && echo "$f" > "$CACHE"
  fi
fi
[ -z "$f" ] && exit 0

# Per-session cost: use statusline if session matches, else cached
sess_cost=""
sess_duration=""
if [ -n "$sl_session_id" ] && [ "$sl_session_id" = "$SID" ]; then
  sess_cost="$sl_cost"
  sess_duration="$sl_duration"
elif [ -f "/tmp/ezydev-claude-cost-$SID.txt" ]; then
  IFS='|' read sess_cost sess_duration < "/tmp/ezydev-claude-cost-$SID.txt"
fi

# Project cost: sum all cached session costs in the project directory
proj_cost=""
proj_dir=$(dirname "$f")
if [ -d "$proj_dir" ]; then
  proj_cost=0
  for sf in "$proj_dir"/*.jsonl; do
    [ ! -f "$sf" ] && continue
    sid=$(basename "$sf" .jsonl)
    sc=""
    if [ -n "$sl_session_id" ] && [ "$sid" = "$sl_session_id" ] && [ -n "$sl_cost" ]; then
      sc="$sl_cost"
    elif [ -f "/tmp/ezydev-claude-cost-$sid.txt" ]; then
      sc=$(cut -d'|' -f1 "/tmp/ezydev-claude-cost-$sid.txt")
    fi
    [ -n "$sc" ] && proj_cost=$(awk "BEGIN{{printf \"%.6f\", $proj_cost + $sc}}")
  done
fi

# Extract custom title (from /rename command)
custom_title=$(tac "$f" 2>/dev/null | grep '"custom-title"' | head -1 | jq -r '.customTitle // empty' 2>/dev/null)

line=$(tac "$f" 2>/dev/null | grep '"message"' | grep '"usage"' | head -1)
if [ -z "$line" ]; then
  if [ -n "$sl_window" ]; then
    echo "0|$sl_window|$sl_model|$sl_used_pct|$sess_cost|$sess_duration|$sl_version|||0|$proj_cost|$effort_level|$custom_title"
  fi
  exit 0
fi
total=$(echo "$line" | jq '((.message.usage.input_tokens // 0) + (.message.usage.cache_creation_input_tokens // 0) + (.message.usage.cache_read_input_tokens // 0) + (.message.usage.output_tokens // 0))' 2>/dev/null)
[ -z "$total" ] || [ "$total" = "null" ] || [ "$total" = "0" ] && exit 0
service_tier=$(echo "$line" | jq -r '.message.usage.service_tier // empty' 2>/dev/null)
speed=$(echo "$line" | jq -r '.message.usage.speed // empty' 2>/dev/null)
window="${{sl_window:-200000}}"
model="${{sl_model:-$(echo "$line" | jq -r '.message.model // empty' 2>/dev/null)}}"
compact_count=$(grep -c 'compact_boundary' "$f" 2>/dev/null || echo 0)
echo "$total|$window|$model|$sl_used_pct|$sess_cost|$sess_duration|$sl_version|$service_tier|$speed|$compact_count|$proj_cost|$effort_level|$custom_title"
"#,
            session_id = session_id
        ),
        "codex" => format!(
            r#"
command -v jq >/dev/null 2>&1 || exit 0
SID='{session_id}'
if [ "$SID" = "__latest__" ]; then
  # No specific session — use the most recent session file
  f=$(find ~/.codex/sessions/ -name '*.jsonl' -type f 2>/dev/null | xargs ls -1t 2>/dev/null | head -1)
else
  CACHE="/tmp/ezydev-sessionpath-$SID"
  if [ -f "$CACHE" ]; then
    f=$(cat "$CACHE")
    [ ! -f "$f" ] && rm -f "$CACHE" && f=""
  fi
  if [ -z "$f" ]; then
    f=$(find ~/.codex/sessions/ -name "*$SID*.jsonl" -type f 2>/dev/null | head -1)
    [ -n "$f" ] && echo "$f" > "$CACHE"
  fi
fi
[ -z "$f" ] && exit 0

# Try current session first for token data
line=$(tac "$f" 2>/dev/null | grep '"model_context_window"' | head -1)
used=""
window=""
model=""
if [ -n "$line" ]; then
  used=$(echo "$line" | jq '.payload.info.last_token_usage.total_tokens // 0' 2>/dev/null)
  window=$(echo "$line" | jq '.payload.info.model_context_window // 0' 2>/dev/null)
  [ "$used" = "null" ] || [ "$used" = "0" ] && used=""
  [ "$window" = "null" ] || [ "$window" = "0" ] && window=""
fi
tc_line=$(tac "$f" 2>/dev/null | grep -m1 'turn_context')
model=$(echo "$tc_line" | jq -r '.payload.model // empty' 2>/dev/null)
effort=$(echo "$tc_line" | jq -r '.payload.effort // empty' 2>/dev/null)
collab_mode=$(echo "$tc_line" | jq -r '.payload.collaboration_mode.mode // empty' 2>/dev/null)

# __latest__ mode = new pane — never use another session's token count.
[ "$SID" = "__latest__" ] && used=""

# Fallback: if current session has no window/model, get from recent sessions.
# NEVER use another session's 'used' — context % is session-specific.
if [ -z "$window" ]; then
  for rf in $(find ~/.codex/sessions/ -name '*.jsonl' -type f 2>/dev/null | xargs ls -1t 2>/dev/null | head -10); do
    [ "$rf" = "$f" ] && continue
    fb_line=$(tac "$rf" 2>/dev/null | grep '"model_context_window"' | head -1)
    [ -z "$fb_line" ] && continue
    fb_window=$(echo "$fb_line" | jq '.payload.info.model_context_window // 0' 2>/dev/null)
    [ -z "$fb_window" ] || [ "$fb_window" = "null" ] || [ "$fb_window" = "0" ] && continue
    window="$fb_window"
    if [ -z "$model" ]; then
      fb_tc=$(tac "$rf" 2>/dev/null | grep -m1 'turn_context')
      model=$(echo "$fb_tc" | jq -r '.payload.model // empty' 2>/dev/null)
      [ -z "$effort" ] && effort=$(echo "$fb_tc" | jq -r '.payload.effort // empty' 2>/dev/null)
      [ -z "$collab_mode" ] && collab_mode=$(echo "$fb_tc" | jq -r '.payload.collaboration_mode.mode // empty' 2>/dev/null)
    fi
    break
  done
fi

# New session with no token data yet = 0 used (100% remaining)
[ -z "$used" ] && used=0
[ -z "$window" ] && exit 0

# Rate limits: account-level — always search all sessions (newest file first)
rl_line=""
for rf in $(find ~/.codex/sessions/ -name '*.jsonl' -type f 2>/dev/null | xargs ls -1t 2>/dev/null | head -15); do
  rl_line=$(tac "$rf" 2>/dev/null | grep '"rate_limits"' | grep -v '"rate_limits":null' | grep -m1 '"used_percent"')
  [ -n "$rl_line" ] && break
done
rl5h=""
rlweek=""
if [ -n "$rl_line" ]; then
  rl5h=$(echo "$rl_line" | jq -r '.payload.rate_limits.primary.used_percent // empty' 2>/dev/null)
  rlweek=$(echo "$rl_line" | jq -r '.payload.rate_limits.secondary.used_percent // empty' 2>/dev/null)
fi
# Read session title from SQLite
title=""
if [ "$SID" != "__latest__" ]; then
  db="$HOME/.codex/state_5.sqlite"
  [ -f "$db" ] && title=$(python3 -c "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);r=c.execute('SELECT title FROM threads WHERE id=?',(sys.argv[2],)).fetchone();print(r[0] if r else '')" "$db" "$SID" 2>/dev/null)
fi
echo "$used|$window|$model|$rl5h|$rlweek|$effort|$collab_mode|$title"
"#,
            session_id = session_id
        ),
        "gemini" => format!(
            r#"
command -v jq >/dev/null 2>&1 || exit 0

# --- Gemini quota (requests per day) via cached API call ---
gemini_quota_used() {{
  local model_name="$1"
  local QC="/tmp/ezydev-gemini-quota.json"
  command -v curl >/dev/null 2>&1 || return
  # Refresh cache if stale (> 60 seconds)
  local now=$(date +%s)
  local mtime=$(stat -c %Y "$QC" 2>/dev/null || echo 0)
  if [ ! -f "$QC" ] || [ $(( now - mtime )) -gt 60 ]; then
    local CREDS="$HOME/.gemini/oauth_creds.json"
    [ ! -f "$CREDS" ] && return
    local TOKEN=$(jq -r '.access_token // empty' "$CREDS" 2>/dev/null)
    [ -z "$TOKEN" ] && return
    local resp
    resp=$(curl -s -m 5 -X POST \
      'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota' \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d '{{}}' 2>/dev/null)
    # If token expired (401), refresh it
    if echo "$resp" | jq -e '.error.code == 401' >/dev/null 2>&1; then
      local REFRESH=$(jq -r '.refresh_token // empty' "$CREDS" 2>/dev/null)
      if [ -n "$REFRESH" ]; then
        TOKEN=$(curl -s -m 5 -X POST 'https://oauth2.googleapis.com/token' \
          -d "client_id=681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com" \
          -d "client_secret=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" \
          -d "refresh_token=$REFRESH" \
          -d "grant_type=refresh_token" 2>/dev/null | jq -r '.access_token // empty')
        [ -z "$TOKEN" ] && return
        resp=$(curl -s -m 5 -X POST \
          'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota' \
          -H "Authorization: Bearer $TOKEN" \
          -H "Content-Type: application/json" \
          -d '{{}}' 2>/dev/null)
      fi
    fi
    if echo "$resp" | jq -e '.buckets' >/dev/null 2>&1; then
      echo "$resp" > "$QC"
    fi
  fi
  # Read cached quota — match model by prefix (strip -preview, -001)
  [ ! -f "$QC" ] && return
  local base=$(echo "$model_name" | sed 's/-preview$//' | sed 's/-[0-9]*$//')
  # Try exact prefix match, then progressively shorter prefixes
  local frac=""
  frac=$(jq -r --arg m "$base" '[.buckets[] | select(.modelId == $m) | .remainingFraction] | first // empty' "$QC" 2>/dev/null)
  if [ -z "$frac" ]; then
    frac=$(jq -r --arg m "$base" '[.buckets[] | select(.modelId | startswith($m)) | .remainingFraction] | first // empty' "$QC" 2>/dev/null)
  fi
  if [ -n "$frac" ] && [ "$frac" != "null" ]; then
    echo "$frac" | awk '{{printf "%.2f", (1-$1)*100}}'
  fi
}}

SID='{session_id}'
if [ "$SID" = "__latest__" ]; then
  # New pane — get model from most recent session, used=0 (100% remaining).
  f=$(ls -1t ~/.gemini/tmp/*/chats/*.json 2>/dev/null | head -1)
  model=""
  if [ -n "$f" ]; then
    model=$(jq -r '[.messages[] | select(.model) | .model] | last // empty' "$f" 2>/dev/null)
  fi
  rpd=""
  reset_time=""
  [ -n "$model" ] && rpd=$(gemini_quota_used "$model")
  QC="/tmp/ezydev-gemini-quota.json"
  if [ -f "$QC" ] && [ -n "$model" ]; then
    base=$(echo "$model" | sed 's/-preview$//' | sed 's/-[0-9]*$//')
    reset_time=$(jq -r --arg m "$base" '[.buckets[] | select(.modelId == $m or (.modelId | startswith($m))) | .resetTime] | first // empty' "$QC" 2>/dev/null)
  fi
  echo "0|1000000|$model|$rpd|||$reset_time"
  exit 0
fi
CACHE="/tmp/ezydev-sessionpath-$SID"
if [ -f "$CACHE" ]; then
  f=$(cat "$CACHE")
  [ ! -f "$f" ] && rm -f "$CACHE" && f=""
fi
if [ -z "$f" ]; then
  f=$(grep -rl "$SID" ~/.gemini/tmp/*/chats/*.json 2>/dev/null | head -1)
  [ -n "$f" ] && echo "$f" > "$CACHE"
fi
[ -z "$f" ] && exit 0
inp=$(jq '[.messages[] | select(.tokens) | .tokens.input] | last // 0' "$f" 2>/dev/null)
[ -z "$inp" ] || [ "$inp" = "null" ] || [ "$inp" = "0" ] && exit 0
model=$(jq -r '[.messages[] | select(.model) | .model] | last // empty' "$f" 2>/dev/null)
case "$model" in
  gemini-2.5-pro*)   window=1000000 ;;
  gemini-2.5-flash*) window=1000000 ;;
  gemini-3-pro*)     window=1000000 ;;
  gemini-3-flash*)   window=1000000 ;;
  *)                 window=1000000 ;;
esac
rpd=""
[ -n "$model" ] && rpd=$(gemini_quota_used "$model")
# Extract summary, last thinking tokens, and quota reset time
summary=$(jq -r '.summary // empty' "$f" 2>/dev/null)
thoughts=$(jq '[.messages[] | select(.tokens.thoughts) | .tokens.thoughts] | last // 0' "$f" 2>/dev/null)
[ "$thoughts" = "null" ] && thoughts=0
QC="/tmp/ezydev-gemini-quota.json"
reset_time=""
if [ -f "$QC" ] && [ -n "$model" ]; then
  base=$(echo "$model" | sed 's/-preview$//' | sed 's/-[0-9]*$//')
  reset_time=$(jq -r --arg m "$base" '[.buckets[] | select(.modelId == $m or (.modelId | startswith($m))) | .resetTime] | first // empty' "$QC" 2>/dev/null)
fi
echo "$inp|$window|$model|$rpd|$summary|$thoughts|$reset_time"
"#,
            session_id = session_id
        ),
        _ => return Ok(String::new()),
    };

    let mut args = Vec::new();
    if let Some(ref d) = distro {
        args.push("-d".to_string());
        args.push(d.clone());
    }
    args.extend(["--".to_string(), "bash".to_string()]);

    let mut child = wsl_command()
        .args(&args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to spawn wsl: {}", e))?;

    if let Some(ref mut stdin) = child.stdin {
        use std::io::Write;
        let _ = stdin.write_all(script.as_bytes());
    }
    drop(child.stdin.take());

    let output = child.wait_with_output()
        .map_err(|e| format!("Failed to wait for wsl: {}", e))?;

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

// =====================================================================
// Native (macOS / Linux) commands — direct filesystem access, no WSL
// =====================================================================

/// Resolve CLI paths on macOS/Linux using `which`.
/// Returns a BTreeMap<String, String> with cli_name → resolved_path entries.
#[tauri::command]
async fn native_resolve_cli_env(cli_names: Vec<String>) -> Result<std::collections::BTreeMap<String, String>, String> {
    let mut result = std::collections::BTreeMap::new();

    for name in &cli_names {
        let output = Command::new("which")
            .arg(name)
            .output();

        if let Ok(o) = output {
            if o.status.success() {
                let stdout = String::from_utf8_lossy(&o.stdout);
                if let Some(first_line) = stdout.lines().next() {
                    let path = first_line.trim();
                    if !path.is_empty() {
                        result.insert(name.clone(), path.to_string());
                    }
                }
            }
        }
    }

    Ok(result)
}

/// Find the most recent Claude session ID on macOS/Linux (native filesystem).
/// Claude stores sessions at $HOME/.claude/projects/<encoded-path>/<uuid>.jsonl
#[tauri::command]
async fn get_claude_session_id_native(project_path: String, exclude_ids: Vec<String>, max_age_secs: Option<u64>) -> Result<Option<String>, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let encoded = project_path.replace('/', "-");
    let encoded = encoded.trim_start_matches('-').to_string();
    let session_dir = std::path::Path::new(&home).join(".claude").join("projects").join(&encoded);

    if !session_dir.exists() {
        // Try case-insensitive match
        let projects_dir = std::path::Path::new(&home).join(".claude").join("projects");
        if !projects_dir.exists() { return Ok(None); }
        let encoded_lower = encoded.to_lowercase();
        let mut found_dir: Option<std::path::PathBuf> = None;
        if let Ok(entries) = std::fs::read_dir(&projects_dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                if entry.file_name().to_string_lossy().to_lowercase() == encoded_lower {
                    found_dir = Some(entry.path());
                    break;
                }
            }
        }
        if found_dir.is_none() { return Ok(None); }
        return find_newest_uuid_jsonl(&found_dir.unwrap(), &exclude_ids, max_age_secs);
    }

    find_newest_uuid_jsonl(&session_dir, &exclude_ids, max_age_secs)
}

/// Helper: find the newest UUID.jsonl in a directory, excluding given IDs.
/// If `max_age_secs` is provided, only consider files modified within the last N seconds.
fn find_newest_uuid_jsonl(dir: &std::path::Path, exclude_ids: &[String], max_age_secs: Option<u64>) -> Result<Option<String>, String> {
    let is_valid_uuid = |s: &str| -> bool {
        s.len() == 36
            && s.split('-').count() == 5
            && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
    };

    let now = std::time::SystemTime::now();

    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .map_err(|e| format!("Failed to read session dir: {}", e))?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map_or(false, |ext| ext == "jsonl"))
        .filter_map(|e| {
            let mtime = e.metadata().ok()?.modified().ok()?;
            // Apply recency filter: skip files older than max_age_secs
            if let Some(max_age) = max_age_secs {
                if let Ok(age) = now.duration_since(mtime) {
                    if age.as_secs() > max_age {
                        return None;
                    }
                }
            }
            Some((e, mtime))
        })
        .collect();
    entries.sort_by(|a, b| b.1.cmp(&a.1));

    for (entry, _) in entries {
        if let Some(stem) = entry.path().file_stem().and_then(|s| s.to_str()) {
            if is_valid_uuid(stem) && !exclude_ids.iter().any(|ex| ex == stem) {
                return Ok(Some(stem.to_string()));
            }
        }
    }

    Ok(None)
}

/// Find the most recent Codex session ID on macOS/Linux (native filesystem).
#[tauri::command]
async fn get_codex_session_id_native(project_path: String, exclude_ids: Vec<String>) -> Result<Option<String>, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let codex_dir = std::path::Path::new(&home).join(".codex");

    let is_valid_uuid = |s: &str| -> bool {
        s.len() == 36
            && s.split('-').count() == 5
            && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
    };

    // Primary: query SQLite via python3
    let db_path = codex_dir.join("state_5.sqlite");
    if db_path.exists() {
        let exclude_csv = exclude_ids.join(",");
        let py_script = format!(
            r#"import sqlite3,sys;c=sqlite3.connect(r'{}');exclude=set(sys.argv[1].split(',')) if sys.argv[1] else set();path=sys.argv[2];rows=c.execute('SELECT id FROM threads WHERE cwd=? ORDER BY updated_at DESC LIMIT 20',(path,)).fetchall();
[print(r[0]) or sys.exit(0) for r in rows if r[0] not in exclude]"#,
            db_path.display()
        );
        let output = Command::new("python3")
            .args(["-c", &py_script, &exclude_csv, &project_path])
            .output();
        if let Ok(o) = output {
            let stdout = String::from_utf8_lossy(&o.stdout).trim().to_string();
            for line in stdout.lines() {
                let id = line.trim();
                if is_valid_uuid(id) {
                    return Ok(Some(id.to_string()));
                }
            }
        }
    }

    // Fallback: scan JSONL files
    let sessions_dir = codex_dir.join("sessions");
    if !sessions_dir.exists() {
        return Ok(None);
    }

    let mut files: Vec<(std::path::PathBuf, std::time::SystemTime)> = Vec::new();
    fn walk_native(dir: &std::path::Path, files: &mut Vec<(std::path::PathBuf, std::time::SystemTime)>) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let path = entry.path();
                if path.is_dir() { walk_native(&path, files); }
                else if path.extension().map_or(false, |ext| ext == "jsonl") {
                    if let Ok(m) = entry.metadata() {
                        if let Ok(t) = m.modified() { files.push((path, t)); }
                    }
                }
            }
        }
    }
    walk_native(&sessions_dir, &mut files);
    files.sort_by(|a, b| b.1.cmp(&a.1));

    for (path, _) in files.iter().take(20) {
        if let Ok(file) = std::fs::File::open(path) {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(file);
            if let Some(Ok(first_line)) = reader.lines().next() {
                let cwd_match = format!("\"cwd\":\"{}\"", project_path);
                let cwd_match_spaced = format!("\"cwd\": \"{}\"", project_path);
                if !first_line.contains(&cwd_match) && !first_line.contains(&cwd_match_spaced) {
                    continue;
                }
                // Extract UUID from "id":"<uuid>" in the line
                if let Some(id_start) = first_line.find("\"id\":\"").or_else(|| first_line.find("\"id\": \"")) {
                    let after = &first_line[id_start..];
                    // Skip past "id":" to find the UUID
                    let colon_quote = after.find(':').unwrap_or(0);
                    let remaining = &after[colon_quote+1..];
                    let remaining = remaining.trim().trim_start_matches('"');
                    if let Some(end) = remaining.find('"') {
                        let id = &remaining[..end];
                        if is_valid_uuid(id) && !exclude_ids.iter().any(|ex| ex == id) {
                            return Ok(Some(id.to_string()));
                        }
                    }
                }
            }
        }
    }

    Ok(None)
}

/// Find the most recent Gemini session ID on macOS/Linux (native filesystem).
#[tauri::command]
async fn get_gemini_session_id_native(project_path: String, exclude_ids: Vec<String>) -> Result<Option<String>, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let tmp_dir = std::path::Path::new(&home).join(".gemini").join("tmp");

    if !tmp_dir.exists() {
        return Ok(None);
    }

    let basename = project_path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_lowercase();

    let is_valid_uuid = |s: &str| -> bool {
        s.len() == 36
            && s.split('-').count() == 5
            && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
    };

    // Collect matching project dirs
    let mut session_files: Vec<(std::path::PathBuf, std::time::SystemTime)> = Vec::new();
    if let Ok(projects) = std::fs::read_dir(&tmp_dir) {
        for proj in projects.filter_map(|e| e.ok()) {
            let name = proj.file_name().to_string_lossy().to_lowercase();
            if !basename.is_empty() && name != basename && !name.starts_with(&format!("{}-", basename)) {
                continue;
            }
            let chats = proj.path().join("chats");
            if chats.is_dir() {
                if let Ok(entries) = std::fs::read_dir(&chats) {
                    for entry in entries.filter_map(|e| e.ok()) {
                        let path = entry.path();
                        if path.extension().map_or(false, |ext| ext == "json") {
                            if let Ok(m) = entry.metadata() {
                                if let Ok(t) = m.modified() { session_files.push((path, t)); }
                            }
                        }
                    }
                }
            }
        }
    }
    session_files.sort_by(|a, b| b.1.cmp(&a.1));

    for (path, _) in session_files.iter().take(20) {
        if let Ok(content) = std::fs::read_to_string(path) {
            // Look for "sessionId" in JSON
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(sid) = v.get("sessionId").and_then(|v| v.as_str()) {
                    if is_valid_uuid(sid) && !exclude_ids.iter().any(|ex| ex == sid) {
                        return Ok(Some(sid.to_string()));
                    }
                }
            }
        }
    }

    Ok(None)
}

/// Read session context on macOS/Linux (native filesystem).
/// Same logic as read_session_context_windows but uses $HOME instead of %USERPROFILE%.
#[tauri::command]
async fn read_session_context_native(
    terminal_type: String,
    session_id: String,
) -> Result<String, String> {
    if session_id.is_empty() {
        return Ok(String::new());
    }
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;

    // Delegate to the same logic as Windows, just using $HOME
    // We reuse the read_session_context_windows logic by setting USERPROFILE temporarily
    // Actually, let's just inline the same pattern with $HOME

    let is_latest = session_id == "__latest__";

    match terminal_type.as_str() {
        "claude" => {
            // Read statusline JSON if available
            let sl_path = std::path::Path::new(&home).join(".ezydev").join("claude-statusline.json");
            let mut sl_window: Option<u64> = None;
            let mut sl_model: Option<String> = None;
            let mut sl_used_pct: Option<u64> = None;
            let mut sl_cost: Option<f64> = None;
            let mut sl_duration: Option<u64> = None;
            let mut sl_version: Option<String> = None;
            let mut sl_session_id: Option<String> = None;
            if let Ok(content) = std::fs::read_to_string(&sl_path) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                    sl_window = v.pointer("/context_window/context_window_size").and_then(|v| v.as_u64());
                    sl_model = v.pointer("/model/display_name").and_then(|v| v.as_str()).map(|s| s.to_string());
                    sl_used_pct = v.pointer("/context_window/used_percentage").and_then(|v| v.as_u64());
                    sl_cost = v.pointer("/cost/total_cost_usd").and_then(|v| v.as_f64());
                    sl_duration = v.pointer("/cost/total_duration_ms").and_then(|v| v.as_u64());
                    sl_version = v.pointer("/version").and_then(|v| v.as_str()).map(|s| s.to_string());
                    sl_session_id = v.pointer("/session_id").and_then(|v| v.as_str()).map(|s| s.to_string());
                    if let (Some(ref sid), Some(cost)) = (&sl_session_id, sl_cost) {
                        let cache_path = std::env::temp_dir().join(format!("ezydev-claude-cost-{}.txt", sid));
                        let dur_str = sl_duration.map(|d| d.to_string()).unwrap_or_default();
                        let _ = std::fs::write(&cache_path, format!("{:.6}|{}", cost, dur_str));
                    }
                }
            }

            let used_pct_str = sl_used_pct.map(|v| v.to_string()).unwrap_or_default();
            let ver_str = sl_version.unwrap_or_default();

            // Read effortLevel from ~/.claude/settings.json
            let effort_level: String = {
                let settings_path = std::path::Path::new(&home).join(".claude").join("settings.json");
                std::fs::read_to_string(&settings_path).ok()
                    .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
                    .and_then(|v| v.get("effortLevel").and_then(|v| v.as_str()).map(|s| s.to_string()))
                    .unwrap_or_default()
            };

            if is_latest {
                if let Some(w) = sl_window {
                    return Ok(format!("0|{}|{}|{}|||{}|||||{}", w, sl_model.as_deref().unwrap_or(""), used_pct_str, ver_str, effort_level));
                }
                return Ok(String::new());
            }

            // Find session file
            let claude_dir = std::path::Path::new(&home).join(".claude").join("projects");
            let mut session_file: Option<std::path::PathBuf> = None;
            if claude_dir.exists() {
                if let Ok(projects) = std::fs::read_dir(&claude_dir) {
                    for proj in projects.filter_map(|e| e.ok()) {
                        let candidate = proj.path().join(format!("{}.jsonl", session_id));
                        if candidate.exists() {
                            session_file = Some(candidate);
                            break;
                        }
                    }
                }
            }

            let f = match session_file {
                Some(f) => f,
                None => return Ok(String::new()),
            };

            // Read last usage line + extract service_tier/speed
            let content = std::fs::read_to_string(&f).map_err(|e| e.to_string())?;
            let mut total: u64 = 0;
            let mut service_tier = String::new();
            let mut speed = String::new();
            for line in content.lines().rev() {
                if line.contains("\"message\"") && line.contains("\"usage\"") {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                        if let Some(usage) = v.pointer("/message/usage") {
                            let input = usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                            let cache_create = usage.get("cache_creation_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                            let cache_read = usage.get("cache_read_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                            let output = usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                            total = input + cache_create + cache_read + output;
                            if let Some(st) = usage.get("service_tier").and_then(|v| v.as_str()) {
                                service_tier = st.to_string();
                            }
                            if let Some(sp) = usage.get("speed").and_then(|v| v.as_str()) {
                                speed = sp.to_string();
                            }
                            break;
                        }
                    }
                }
            }

            // Count context compactions + extract custom title
            let compact_count = content.lines().filter(|l| l.contains("compact_boundary")).count();
            let mut custom_title = String::new();
            for line in content.lines().rev() {
                if line.contains("\"custom-title\"") {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                        if let Some(t) = v.get("customTitle").and_then(|v| v.as_str()) {
                            custom_title = t.to_string();
                            break;
                        }
                    }
                }
            }

            let (sess_cost, sess_duration): (Option<f64>, Option<u64>) =
                if sl_session_id.as_deref() == Some(&session_id) {
                    (sl_cost, sl_duration)
                } else {
                    let cache_path = std::env::temp_dir().join(format!("ezydev-claude-cost-{}.txt", session_id));
                    if let Ok(cached) = std::fs::read_to_string(&cache_path) {
                        let parts: Vec<&str> = cached.trim().split('|').collect();
                        let c = parts.first().and_then(|s| s.parse::<f64>().ok());
                        let d = parts.get(1).and_then(|s| s.parse::<u64>().ok());
                        (c, d)
                    } else {
                        (None, None)
                    }
                };

            let proj_cost: Option<f64> = {
                let proj_dir = f.parent();
                if let Some(dir) = proj_dir {
                    let mut total_cost: f64 = 0.0;
                    let mut found_any = false;
                    if let Ok(entries) = std::fs::read_dir(dir) {
                        for entry in entries.filter_map(|e| e.ok()) {
                            let path = entry.path();
                            if path.extension().map_or(true, |ext| ext != "jsonl") { continue; }
                            let sid = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                            let sc = if sl_session_id.as_deref() == Some(&sid) {
                                sl_cost
                            } else {
                                let cp = std::env::temp_dir().join(format!("ezydev-claude-cost-{}.txt", sid));
                                std::fs::read_to_string(&cp).ok()
                                    .and_then(|c| c.trim().split('|').next().and_then(|s| s.parse::<f64>().ok()))
                            };
                            if let Some(c) = sc { total_cost += c; found_any = true; }
                        }
                    }
                    if found_any { Some(total_cost) } else { None }
                } else { None }
            };

            let cost_str = sess_cost.map(|c| format!("{:.6}", c)).unwrap_or_default();
            let dur_str = sess_duration.map(|d| d.to_string()).unwrap_or_default();
            let proj_str = proj_cost.map(|c| format!("{:.6}", c)).unwrap_or_default();

            if total == 0 {
                if let Some(w) = sl_window {
                    // 0|window|model|used_pct|cost|dur|version|||compact|proj|effort|custom_title
                    return Ok(format!("0|{}|{}|{}|{}|{}|{}|||{}|{}|{}|{}", w, sl_model.as_deref().unwrap_or(""), used_pct_str, cost_str, dur_str, ver_str, compact_count, proj_str, effort_level, custom_title));
                }
                return Ok(String::new());
            }

            let window = sl_window.unwrap_or(200000);
            let model_str = sl_model.unwrap_or_default();
            // total|window|model|used_pct|cost|dur|version|tier|speed|compact|proj|effort|custom_title
            Ok(format!("{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}", total, window, model_str, used_pct_str, cost_str, dur_str, ver_str, service_tier, speed, compact_count, proj_str, effort_level, custom_title))
        },
        "codex" => {
            let sessions_dir = std::path::Path::new(&home).join(".codex").join("sessions");
            if !sessions_dir.exists() {
                return Ok(String::new());
            }

            let target_file: Option<std::path::PathBuf>;
            if is_latest {
                let mut files: Vec<(std::path::PathBuf, std::time::SystemTime)> = Vec::new();
                fn walk_n(dir: &std::path::Path, files: &mut Vec<(std::path::PathBuf, std::time::SystemTime)>) {
                    if let Ok(entries) = std::fs::read_dir(dir) {
                        for entry in entries.filter_map(|e| e.ok()) {
                            let path = entry.path();
                            if path.is_dir() { walk_n(&path, files); }
                            else if path.extension().map_or(false, |ext| ext == "jsonl") {
                                if let Ok(m) = entry.metadata() {
                                    if let Ok(t) = m.modified() { files.push((path, t)); }
                                }
                            }
                        }
                    }
                }
                walk_n(&sessions_dir, &mut files);
                files.sort_by(|a, b| b.1.cmp(&a.1));
                target_file = files.into_iter().next().map(|(p, _)| p);
            } else {
                fn walk_n2(dir: &std::path::Path, uuid: &str) -> Option<std::path::PathBuf> {
                    if let Ok(entries) = std::fs::read_dir(dir) {
                        for entry in entries.filter_map(|e| e.ok()) {
                            let path = entry.path();
                            if path.is_dir() {
                                if let Some(found) = walk_n2(&path, uuid) { return Some(found); }
                            } else if path.file_name().map_or(false, |n| n.to_string_lossy().contains(uuid)) {
                                return Some(path);
                            }
                        }
                    }
                    None
                }
                target_file = walk_n2(&sessions_dir, &session_id);
            }

            let f = match target_file {
                Some(f) => f,
                None => return Ok(String::new()),
            };

            let content = std::fs::read_to_string(&f).map_err(|e| e.to_string())?;
            let mut used: Option<u64> = None;
            let mut window: Option<u64> = None;
            let mut model = String::new();
            let mut effort = String::new();
            let mut collab_mode = String::new();

            for line in content.lines().rev() {
                if window.is_some() && (used.is_some() || is_latest) { break; }
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                    if window.is_none() {
                        if let Some(w) = v.pointer("/payload/info/model_context_window").and_then(|v| v.as_u64()) {
                            if w > 0 { window = Some(w); }
                        }
                        if used.is_none() && !is_latest {
                            if let Some(u) = v.pointer("/payload/info/last_token_usage/total_tokens").and_then(|v| v.as_u64()) {
                                if u > 0 { used = Some(u); }
                            }
                        }
                    }
                    if model.is_empty() {
                        if let Some(m) = v.pointer("/payload/model").and_then(|v| v.as_str()) {
                            model = m.to_string();
                        }
                    }
                    if effort.is_empty() {
                        if let Some(e) = v.pointer("/payload/effort").and_then(|v| v.as_str()) {
                            effort = e.to_string();
                        }
                    }
                    if collab_mode.is_empty() {
                        if let Some(cm) = v.pointer("/payload/collaboration_mode/mode").and_then(|v| v.as_str()) {
                            collab_mode = cm.to_string();
                        }
                    }
                }
            }

            if is_latest { used = None; }
            let used_val = used.unwrap_or(0);
            let window_val = match window {
                Some(w) => w,
                None => return Ok(String::new()),
            };

            let mut rl5h: Option<f64> = None;
            let mut rlweek: Option<f64> = None;
            {
                let mut all_files: Vec<(std::path::PathBuf, std::time::SystemTime)> = Vec::new();
                fn walk_nrl(dir: &std::path::Path, files: &mut Vec<(std::path::PathBuf, std::time::SystemTime)>) {
                    if let Ok(entries) = std::fs::read_dir(dir) {
                        for entry in entries.filter_map(|e| e.ok()) {
                            let path = entry.path();
                            if path.is_dir() { walk_nrl(&path, files); }
                            else if path.extension().map_or(false, |ext| ext == "jsonl") {
                                if let Ok(m) = entry.metadata() {
                                    if let Ok(t) = m.modified() { files.push((path, t)); }
                                }
                            }
                        }
                    }
                }
                walk_nrl(&sessions_dir, &mut all_files);
                all_files.sort_by(|a, b| b.1.cmp(&a.1));
                for (rf, _) in all_files.iter().take(15) {
                    if let Ok(rc) = std::fs::read_to_string(rf) {
                        for line in rc.lines().rev() {
                            if !line.contains("\"rate_limits\"") || line.contains("\"rate_limits\":null") { continue; }
                            if !line.contains("\"used_percent\"") { continue; }
                            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                                rl5h = v.pointer("/payload/rate_limits/primary/used_percent").and_then(|v| v.as_f64());
                                rlweek = v.pointer("/payload/rate_limits/secondary/used_percent").and_then(|v| v.as_f64());
                                break;
                            }
                        }
                    }
                    if rl5h.is_some() { break; }
                }
            }
            let rl5h_str = rl5h.map(|v| format!("{:.2}", v)).unwrap_or_default();
            let rlweek_str = rlweek.map(|v| format!("{:.2}", v)).unwrap_or_default();

            // Read session title from SQLite
            let mut title = String::new();
            if !is_latest {
                let db_path = std::path::Path::new(&home).join(".codex").join("state_5.sqlite");
                if db_path.exists() {
                    let py = format!(
                        r#"import sqlite3,sys;c=sqlite3.connect(r'{}');r=c.execute('SELECT title FROM threads WHERE id=?',(sys.argv[1],)).fetchone();print(r[0] if r else '')"#,
                        db_path.display()
                    );
                    if let Ok(out) = std::process::Command::new("python3").args(["-c", &py, &session_id]).output() {
                        title = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    }
                }
            }

            Ok(format!("{}|{}|{}|{}|{}|{}|{}|{}", used_val, window_val, model, rl5h_str, rlweek_str, effort, collab_mode, title))
        },
        "gemini" => {
            let tmp_dir = std::path::Path::new(&home).join(".gemini").join("tmp");
            if !tmp_dir.exists() {
                return Ok(String::new());
            }

            let mut files: Vec<(std::path::PathBuf, std::time::SystemTime)> = Vec::new();
            if let Ok(projects) = std::fs::read_dir(&tmp_dir) {
                for proj in projects.filter_map(|e| e.ok()) {
                    let chats = proj.path().join("chats");
                    if chats.is_dir() {
                        if let Ok(entries) = std::fs::read_dir(&chats) {
                            for entry in entries.filter_map(|e| e.ok()) {
                                let path = entry.path();
                                if path.extension().map_or(false, |ext| ext == "json") {
                                    if let Ok(m) = entry.metadata() {
                                        if let Ok(t) = m.modified() { files.push((path, t)); }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            files.sort_by(|a, b| b.1.cmp(&a.1));

            let f = match files.into_iter().next() {
                Some((p, _)) => p,
                None => return Ok(String::new()),
            };

            let content = std::fs::read_to_string(&f).map_err(|e| e.to_string())?;
            let v: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;

            let inp = v.pointer("/messages")
                .and_then(|m| m.as_array())
                .map(|msgs| msgs.iter().rev().find_map(|m| m.pointer("/tokens/input").and_then(|v| v.as_u64())).unwrap_or(0))
                .unwrap_or(0);
            if inp == 0 { return Ok(String::new()); }

            let model = v.pointer("/messages")
                .and_then(|m| m.as_array())
                .map(|msgs| msgs.iter().rev().find_map(|m| m.get("model").and_then(|v| v.as_str())).unwrap_or(""))
                .unwrap_or("");

            let summary = v.get("summary").and_then(|v| v.as_str()).unwrap_or("");

            let thoughts = v.pointer("/messages")
                .and_then(|m| m.as_array())
                .map(|msgs| msgs.iter().rev().find_map(|m| m.pointer("/tokens/thoughts").and_then(|v| v.as_u64())).unwrap_or(0))
                .unwrap_or(0);

            Ok(format!("{}|1000000|{}||{}|{}|", inp, model, summary, thoughts))
        },
        _ => Ok(String::new()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .invoke_handler(tauri::generate_handler![ssh_ls, ssh_test_connection, ssh_keygen, ssh_check_key, ssh_list_keys, read_file, write_file, list_dir, search_in_files, git_is_repo, git_status, git_diff, git_branches, git_diff_stats, git_switch_branch, git_revert_hunk, git_discard_file, git_add, git_reset_files, git_commit, git_push, git_ahead_behind, git_run_typecheck, git_run_lint, git_run_tests, wsl_resolve_cli_env, windows_resolve_cli_env, native_resolve_cli_env, get_claude_session_id, get_codex_session_id, get_gemini_session_id, get_claude_session_id_windows, get_codex_session_id_windows, get_gemini_session_id_windows, get_claude_session_id_native, get_codex_session_id_native, get_gemini_session_id_native, read_session_context_windows, read_session_context_native, save_clipboard_image, cleanup_clipboard_images, poll_clipboard_image, launch_snipping_tool, set_window_corners, install_statusline_wrapper, read_session_context, pty::pty_spawn, pty::pty_spawn_pooled, pty::pty_pool_warm, pty::pty_write, pty::pty_resize, pty::pty_kill])
        .setup(|app| {
            #[cfg(target_os = "windows")]
            {
                // Allocate a hidden console so child processes (wsl.exe) don't
                // create visible console windows. GUI apps have no console by
                // default — any console app spawned as a child creates a new
                // visible console window. Pre-allocating a hidden one makes all
                // children inherit it invisibly.
                {
                    extern "system" {
                        fn AllocConsole() -> i32;
                        fn GetConsoleWindow() -> isize;
                        fn ShowWindow(hwnd: isize, cmd: i32) -> i32;
                    }
                    unsafe {
                        AllocConsole();
                        let hwnd = GetConsoleWindow();
                        if hwnd != 0 {
                            ShowWindow(hwnd, 0); // SW_HIDE
                        }
                    }
                }

                let window = app.get_webview_window("main").expect("main window not found");
                let hwnd = window.hwnd().expect("failed to get HWND");
                win32_border::remove_border(hwnd.0);

                // Keep a persistent WSL process alive — boots the WSL VM and
                // keeps it warm so subsequent wsl.exe calls are fast.
                // Uses /bin/cat which blocks on stdin indefinitely.
                // The child process is killed when the app exits (handle dropped).
                std::thread::spawn(|| {
                    let _ = wsl_command()
                        .args(["-e", "/bin/cat"])
                        .stdin(std::process::Stdio::piped())
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .spawn();
                });
            }

            // macOS: no special window setup needed — using native decorations
            // via tauri.macos.conf.json overlay. No WSL VM to warm.
            #[cfg(target_os = "macos")]
            {
                let _ = app; // suppress unused warning
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
