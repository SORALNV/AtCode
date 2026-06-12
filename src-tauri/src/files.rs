use serde::Serialize;
use std::fs;
use std::path::PathBuf;

/// Workspace where solution files live: ~/AtCode
pub fn workspace_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("AtCode")
}

pub fn snapshots_root() -> PathBuf {
    workspace_path().join(".atcode").join("snapshots")
}

pub fn ensure_workspace() -> std::io::Result<()> {
    fs::create_dir_all(snapshots_root())
}

#[tauri::command]
pub fn workspace_dir() -> String {
    workspace_path().to_string_lossy().to_string()
}

#[derive(Serialize)]
pub struct CreatedFile {
    pub path: String,
    pub name: String,
    pub content: String,
    pub created: bool,
}

const CPP_TEMPLATE: &str = r#"#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    return 0;
}
"#;

const PY_TEMPLATE: &str = r#"import sys

input = sys.stdin.readline


def main():
    pass


main()
"#;

/// Derive a file name like "ABC423_A" from an AtCoder URL.
/// https://atcoder.jp/contests/abc423/tasks/abc423_a -> ABC423_A
/// https://atcoder.jp/contests/abc423              -> ABC423
fn problem_name_from_url(url: &str) -> Option<String> {
    let parsed: tauri::Url = url.parse().ok()?;
    let host = parsed.host_str()?;
    if host != "atcoder.jp" && !host.ends_with(".atcoder.jp") {
        return None;
    }
    let segments: Vec<&str> = parsed.path_segments()?.filter(|s| !s.is_empty()).collect();
    let contest_idx = segments.iter().position(|s| *s == "contests")?;
    let task = segments
        .iter()
        .position(|s| *s == "tasks")
        .and_then(|i| segments.get(i + 1));
    let name = match task {
        Some(t) => (*t).to_string(),
        None => (*segments.get(contest_idx + 1)?).to_string(),
    };
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

#[tauri::command]
pub fn create_problem_file(
    url: String,
    lang: String,
    template: Option<String>,
) -> Result<CreatedFile, String> {
    let name = problem_name_from_url(&url).ok_or(
        "コンテスト/問題ページのURLではありません。AtCoderの問題ページを開いてから押してください。",
    )?;
    let (ext, default_template, comment) = match lang.as_str() {
        "py" => ("py", PY_TEMPLATE, "#"),
        _ => ("cpp", CPP_TEMPLATE, "//"),
    };
    let file_name = format!("{name}.{ext}");
    let path = workspace_path().join(&file_name);

    // A custom template from the settings screen takes precedence.
    let template_body = template
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| default_template.to_string());

    let created = !path.exists();
    let content = if created {
        let body = format!("{comment} {url}\n{template_body}");
        fs::write(&path, &body).map_err(|e| e.to_string())?;
        body
    } else {
        fs::read_to_string(&path).map_err(|e| e.to_string())?
    };

    Ok(CreatedFile {
        path: path.to_string_lossy().to_string(),
        name: file_name,
        content,
        created,
    })
}

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_file(path: String, content: String) -> Result<(), String> {
    fs::write(path, content).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct WorkspaceFile {
    pub name: String,
    pub path: String,
}

/// Solution files in the workspace root (newest first), for the file picker.
#[tauri::command]
pub fn list_workspace_files() -> Result<Vec<WorkspaceFile>, String> {
    let mut entries: Vec<(std::time::SystemTime, WorkspaceFile)> = Vec::new();
    let dir = fs::read_dir(workspace_path()).map_err(|e| e.to_string())?;
    for entry in dir.flatten() {
        let path = entry.path();
        let is_source = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| matches!(e, "cpp" | "py" | "rs" | "java" | "c" | "txt"))
            .unwrap_or(false);
        if !path.is_file() || !is_source {
            continue;
        }
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        entries.push((
            mtime,
            WorkspaceFile {
                name: entry.file_name().to_string_lossy().to_string(),
                path: path.to_string_lossy().to_string(),
            },
        ));
    }
    entries.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(entries.into_iter().map(|(_, f)| f).collect())
}

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// Directory listing for the file-explorer tree. Defaults to the workspace
/// root; dotfiles (e.g. the `.atcode` snapshot store) are hidden.
#[tauri::command]
pub fn read_dir(path: Option<String>) -> Result<Vec<DirEntry>, String> {
    let dir = path.map(PathBuf::from).unwrap_or_else(workspace_path);
    let mut entries: Vec<DirEntry> = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                return None;
            }
            let p = e.path();
            Some(DirEntry {
                name,
                is_dir: p.is_dir(),
                path: p.to_string_lossy().to_string(),
            })
        })
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}
