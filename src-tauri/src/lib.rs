mod pty;

use std::process::Command;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Serialize;
use tauri::Manager;

/// Remove all Windows 11 DWM borders including the 1px top non-client border.
#[cfg(target_os = "windows")]
mod win32_border {
    use std::ffi::c_void;

    const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
    const DWMWCP_DONOTROUND: u32 = 1;
    const DWMWCP_ROUND: u32 = 2;
    const DWMWA_BORDER_COLOR: u32 = 34;
    const DWMWA_COLOR_NONE: u32 = 0xFFFFFFFE;
    const WM_NCCALCSIZE: u32 = 0x0083;
    const GWL_STYLE: i32 = -16;
    const WS_THICKFRAME: isize = 0x00040000;
    const WS_MAXIMIZE: isize = 0x01000000;
    const SWP_FRAMECHANGED: u32 = 0x0020;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOZORDER: u32 = 0x0004;

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
    }

    /// Window subclass proc that intercepts WM_NCCALCSIZE to remove the
    /// 1px top non-client border Windows draws on frameless windows.
    unsafe extern "system" fn subclass_proc(
        hwnd: *mut c_void,
        msg: u32,
        wparam: usize,
        lparam: isize,
        _uid_subclass: usize,
        _ref_data: usize,
    ) -> isize {
        if msg == WM_NCCALCSIZE && wparam == 1 {
            let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
            if (style & WS_MAXIMIZE) == 0 {
                // Not maximized: remove all non-client area so content fills the window.
                return 0;
            }
            // Maximized: fall through to DefSubclassProc.
            // Returning 0 here would make the client rect equal to the raw maximized
            // window rect, which WS_THICKFRAME extends ~8px beyond screen edges.
            // That causes corner content to be clipped off-screen (looks like rounded corners).
            // Letting DefSubclassProc handle it correctly clips the client to the visible monitor area.
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

#[tauri::command]
async fn git_is_repo(directory: String) -> Result<bool, String> {
    let output = Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(&directory)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;
    Ok(output.status.success())
}

#[tauri::command]
async fn git_status(directory: String) -> Result<Vec<GitFileStatus>, String> {
    let output = Command::new("git")
        .args(["status", "--porcelain", "-uall"])
        .current_dir(&directory)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

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
            let output = Command::new("git")
                .args(&args)
                .current_dir(&directory)
                .output()
                .map_err(|e| format!("Failed to run git diff: {}", e))?;
            combined = String::from_utf8_lossy(&output.stdout).to_string();
        }
        None => {
            // Unstaged changes
            let mut args1 = vec!["diff".to_string()];
            if let Some(ref fp) = file_path {
                args1.push("--".to_string());
                args1.push(fp.clone());
            }
            let output1 = Command::new("git")
                .args(&args1)
                .current_dir(&directory)
                .output()
                .map_err(|e| format!("Failed to run git diff: {}", e))?;
            combined.push_str(&String::from_utf8_lossy(&output1.stdout));

            // Staged changes
            let mut args2 = vec!["diff".to_string(), "--cached".to_string()];
            if let Some(ref fp) = file_path {
                args2.push("--".to_string());
                args2.push(fp.clone());
            }
            let output2 = Command::new("git")
                .args(&args2)
                .current_dir(&directory)
                .output()
                .map_err(|e| format!("Failed to run git diff: {}", e))?;
            combined.push_str(&String::from_utf8_lossy(&output2.stdout));
        }
    }

    Ok(combined)
}

#[tauri::command]
async fn git_branches(directory: String) -> Result<GitBranchInfo, String> {
    // Get current branch
    let current_output = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&directory)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;
    let current = String::from_utf8_lossy(&current_output.stdout).trim().to_string();

    // Get all branches
    let branches_output = Command::new("git")
        .args(["branch", "-a", "--format=%(refname:short)"])
        .current_dir(&directory)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;
    let branches: Vec<String> = String::from_utf8_lossy(&branches_output.stdout)
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect();

    Ok(GitBranchInfo { current, branches })
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
        let output = Command::new("git")
            .args(["checkout", "--", &file_path])
            .current_dir(&directory)
            .output()
            .map_err(|e| format!("Failed to run git checkout: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("git checkout failed: {}", stderr.trim()));
        }
    }
    Ok(())
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
/// Only reads the image (slow PowerShell call) when the sequence number changes.
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

    #[cfg(not(target_os = "windows"))]
    {
        let _ = last_seq;
        Err("Clipboard polling only supported on Windows".to_string())
    }
}

/// Launch the Windows Snipping Tool region-select overlay (Win+Shift+S).
#[tauri::command]
async fn launch_snipping_tool() -> Result<(), String> {
    // Start the Screen Sketch / Snip & Sketch overlay directly.
    // This opens the region-selection UI (same as Win+Shift+S).
    let _ = Command::new("cmd.exe")
        .args(["/C", "start", "ms-screenclip:"])
        .output();
    Ok(())
}

/// Read image from the Windows clipboard via PowerShell, save as PNG.
/// Returns the file path and a data URI for thumbnail preview.
/// This avoids web Clipboard API permission prompts.
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

    // Use PowerShell to read image from Windows clipboard and save as PNG.
    // Single-quoted paths in PS: double the single-quotes to escape.
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

    let output = Command::new("wsl.exe")
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
#[tauri::command]
async fn get_claude_session_id(project_path: String, exclude_ids: Vec<String>) -> Result<Option<String>, String> {
    let encoded = project_path.replace('/', "-");

    // Use bash -lic (login shell) to match wsl_resolve_cli_env pattern.
    // List ALL session files sorted by modification time (newest first).
    // We pick the first one not in the exclude list on the Rust side.
    let script = format!(
        "ls -1t ~/.claude/projects/{}/*.jsonl 2>/dev/null | sed 's|.*/||;s|\\.jsonl$||'",
        encoded
    );

    let output = Command::new("wsl.exe")
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
    for line in stdout.lines() {
        let id = line.trim();
        if is_valid_uuid(id) && !exclude_ids.iter().any(|ex| ex == id) {
            return Ok(Some(id.to_string()));
        }
    }

    Ok(None)
}

/// Find the most recent Codex session ID for a given project.
/// Codex stores sessions at ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl
/// The first line of each file is JSON with "cwd" (project path) and "id" (session UUID).
#[tauri::command]
async fn get_codex_session_id(project_path: String, exclude_ids: Vec<String>) -> Result<Option<String>, String> {
    // Find .jsonl files sorted by mtime, read first line of each, filter by cwd,
    // then extract the UUID from the "id" field.
    let script = format!(
        "find ~/.codex/sessions -name '*.jsonl' -type f -printf '%T@ %p\\n' 2>/dev/null | sort -rn | sed 's/^[0-9.]* //' | while IFS= read -r f; do head -1 \"$f\" 2>/dev/null; done | grep '\"cwd\":\"{}\"' | grep -oE '\"id\":\"[0-9a-f]{{8}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{12}}\"' | sed 's/\"id\":\"//;s/\"//'",
        project_path
    );

    let output = Command::new("wsl.exe")
        .args(["--", "bash", "-lic", &script])
        .output()
        .map_err(|e| format!("Failed to query Codex sessions: {}", e))?;

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

/// Find the most recent Gemini session ID.
/// Gemini stores sessions at ~/.gemini/tmp/<project_name>/chats/session-<ts>-<partial_uuid>.json
/// The JSON is pretty-printed; "sessionId" is on line 2.
#[tauri::command]
async fn get_gemini_session_id(exclude_ids: Vec<String>) -> Result<Option<String>, String> {
    // List session files sorted by mtime, grep sessionId from file contents, extract UUID.
    // Uses ls + xargs (like Claude's lookup) instead of find -printf which can fail via wsl.exe.
    let script = "ls -1t ~/.gemini/tmp/*/chats/*.json 2>/dev/null | head -20 | xargs grep -h sessionId 2>/dev/null | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'";

    let output = Command::new("wsl.exe")
        .args(["--", "bash", "-lic", script])
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .invoke_handler(tauri::generate_handler![ssh_ls, ssh_test_connection, read_file, write_file, list_dir, search_in_files, git_is_repo, git_status, git_diff, git_branches, git_revert_hunk, git_discard_file, wsl_resolve_cli_env, get_claude_session_id, get_codex_session_id, get_gemini_session_id, save_clipboard_image, cleanup_clipboard_images, poll_clipboard_image, launch_snipping_tool, set_window_corners, pty::pty_spawn, pty::pty_spawn_pooled, pty::pty_pool_warm, pty::pty_write, pty::pty_resize, pty::pty_kill])
        .setup(|app| {
            #[cfg(target_os = "windows")]
            {
                let window = app.get_webview_window("main").expect("main window not found");
                let hwnd = window.hwnd().expect("failed to get HWND");
                win32_border::remove_border(hwnd.0);

                // Keep a persistent WSL process alive — boots the WSL VM and
                // keeps it warm so subsequent wsl.exe calls are fast.
                // Uses /bin/cat which blocks on stdin indefinitely.
                // The child process is killed when the app exits (handle dropped).
                std::thread::spawn(|| {
                    let _ = Command::new("wsl.exe")
                        .args(["-e", "/bin/cat"])
                        .stdin(std::process::Stdio::piped())
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .spawn();
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
