use std::process::Command;
use serde::Serialize;
use tauri::Manager;

/// Remove all Windows 11 DWM borders including the 1px top non-client border.
#[cfg(target_os = "windows")]
mod win32_border {
    use std::ffi::c_void;

    const DWMWA_BORDER_COLOR: u32 = 34;
    const DWMWA_COLOR_NONE: u32 = 0xFFFFFFFE;
    const WM_NCCALCSIZE: u32 = 0x0083;
    const GWL_STYLE: i32 = -16;
    const WS_THICKFRAME: isize = 0x00040000;
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
            // When wParam is TRUE, returning 0 tells Windows: no non-client area.
            // This removes the 1px top border while WS_THICKFRAME keeps resize working.
            return 0;
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    pub fn remove_border(hwnd: *mut c_void) {
        unsafe {
            // 1) Remove DWM side/bottom border color
            let color = DWMWA_COLOR_NONE;
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_BORDER_COLOR,
                &color as *const u32 as *const c_void,
                std::mem::size_of::<u32>() as u32,
            );

            // 2) Subclass the window to intercept WM_NCCALCSIZE and kill the top border
            SetWindowSubclass(hwnd, Some(subclass_proc), 1, 0);

            // 3) Force Windows to recalculate the frame
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

/// Simple shell escaping for paths (wraps in single quotes)
fn shell_escape(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_pty::init())
        .invoke_handler(tauri::generate_handler![ssh_ls, ssh_test_connection, read_file, write_file, list_dir, search_in_files, git_is_repo, git_status, git_diff, git_branches, git_revert_hunk, git_discard_file])
        .setup(|app| {
            #[cfg(target_os = "windows")]
            {
                let window = app.get_webview_window("main").expect("main window not found");
                let hwnd = window.hwnd().expect("failed to get HWND");
                win32_border::remove_border(hwnd.0);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
