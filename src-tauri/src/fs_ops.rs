//! Local filesystem mutations for the file-tree context menu.
//!
//! MADE had no local mutation commands at all before this — only `write_file`.
//! These four are the smallest set that makes the sidebar menu real: rename,
//! delete, new file, new folder.
//!
//! # Safety model
//!
//! Every path is validated to live **inside the project root** before anything
//! is touched, following the same canonicalise-both-sides discipline as
//! `screenshots::screenshots_delete`. Canonicalising is what defeats `..`
//! traversal and Windows symlink/junction tricks: comparing raw strings would
//! let `C:\proj\..\Windows\System32` through.
//!
//! Creates canonicalise the PARENT, because the target does not exist yet.
//!
//! Deletion goes to the **Recycle Bin**, never `remove_dir_all`. A context menu
//! puts Delete one row away from Rename; an unrecoverable recursive delete
//! behind a single mis-click is not a risk worth taking, and the OS already
//! provides the undo.

use std::path::{Path, PathBuf};

/// Resolve `path` and assert it sits inside `root`.
///
/// Returns the canonical path on success. Both sides are canonicalised first so
/// `..` segments, symlinks and junctions cannot escape the root.
fn contained(root: &str, path: &Path) -> Result<PathBuf, String> {
    let root_c = PathBuf::from(root)
        .canonicalize()
        .map_err(|e| format!("project root is unreadable: {e}"))?;
    let path_c = path
        .canonicalize()
        .map_err(|e| format!("path is unreadable: {e}"))?;
    if !path_c.starts_with(&root_c) {
        return Err("path is outside the project folder".into());
    }
    if path_c == root_c {
        return Err("refusing to operate on the project root itself".into());
    }
    Ok(path_c)
}

/// Same check for a path that does not exist yet: validate its parent.
fn contained_parent(root: &str, path: &Path) -> Result<PathBuf, String> {
    let parent = path.parent().ok_or("path has no parent directory")?;
    let root_c = PathBuf::from(root)
        .canonicalize()
        .map_err(|e| format!("project root is unreadable: {e}"))?;
    let parent_c = parent
        .canonicalize()
        .map_err(|e| format!("parent directory is unreadable: {e}"))?;
    if !parent_c.starts_with(&root_c) {
        return Err("path is outside the project folder".into());
    }
    let name = path.file_name().ok_or("path has no file name")?;
    Ok(parent_c.join(name))
}

/// Reject names that would silently create something other than what was typed.
fn validate_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("name cannot be empty".into());
    }
    if name.contains('/') || name.contains('\\') {
        return Err("name cannot contain a path separator".into());
    }
    if name == "." || name == ".." {
        return Err("invalid name".into());
    }
    Ok(())
}

#[tauri::command]
pub fn fs_rename(root: String, path: String, new_name: String) -> Result<String, String> {
    validate_name(&new_name)?;
    let src = contained(&root, Path::new(&path))?;
    let parent = src.parent().ok_or("cannot rename the filesystem root")?;
    let dst = parent.join(&new_name);
    if dst.exists() {
        return Err(format!("\"{new_name}\" already exists"));
    }
    // Re-validate the destination's parent: `new_name` is user input.
    contained_parent(&root, &dst)?;
    std::fs::rename(&src, &dst).map_err(|e| format!("rename failed: {e}"))?;
    Ok(dst.to_string_lossy().to_string())
}

/// Move a file or directory to the Recycle Bin.
#[tauri::command]
pub fn fs_delete_to_trash(root: String, path: String) -> Result<(), String> {
    let target = contained(&root, Path::new(&path))?;
    trash::delete(&target).map_err(|e| format!("could not move to Recycle Bin: {e}"))
}

#[tauri::command]
pub fn fs_create_file(root: String, dir: String, name: String) -> Result<String, String> {
    validate_name(&name)?;
    let target = contained_parent(&root, &PathBuf::from(&dir).join(&name))?;
    if target.exists() {
        return Err(format!("\"{name}\" already exists"));
    }
    std::fs::write(&target, b"").map_err(|e| format!("could not create file: {e}"))?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub fn fs_create_dir(root: String, dir: String, name: String) -> Result<String, String> {
    validate_name(&name)?;
    let target = contained_parent(&root, &PathBuf::from(&dir).join(&name))?;
    if target.exists() {
        return Err(format!("\"{name}\" already exists"));
    }
    std::fs::create_dir(&target).map_err(|e| format!("could not create folder: {e}"))?;
    Ok(target.to_string_lossy().to_string())
}
