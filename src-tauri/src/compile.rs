use crate::files;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize)]
pub struct CompileResult {
    pub success: bool,
    pub output: String,
    pub compiler: String,
    pub run_cmd: Option<String>,
    pub snapshot_id: Option<String>,
}

#[derive(Serialize)]
pub struct SnapshotInfo {
    pub id: String,
    pub size: u64,
}

fn snapshot_dir_for(file: &Path) -> PathBuf {
    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown".into());
    files::snapshots_root().join(name)
}

/// Save a copy of the file before each compile. Skips if the content is
/// identical to the most recent snapshot. Returns the snapshot id (unix ms).
fn take_snapshot(file: &Path) -> Result<Option<String>, String> {
    let content = fs::read(file).map_err(|e| e.to_string())?;
    let dir = snapshot_dir_for(file);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    if let Some(latest) = newest_snapshot(&dir) {
        if let Ok(prev) = fs::read(&latest) {
            if prev == content {
                return Ok(latest
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string()));
            }
        }
    }

    let id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis()
        .to_string();
    let ext = file
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_else(|| "txt".into());
    fs::write(dir.join(format!("{id}.{ext}")), &content).map_err(|e| e.to_string())?;
    Ok(Some(id))
}

fn newest_snapshot(dir: &Path) -> Option<PathBuf> {
    fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .max_by_key(|p| {
            p.file_stem()
                .and_then(|s| s.to_string_lossy().parse::<u128>().ok())
                .unwrap_or(0)
        })
}

fn command_works(cmd: &str) -> bool {
    Command::new(cmd)
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Prefer Homebrew GCC on macOS (Apple clang lacks bits/stdc++.h).
pub fn find_cpp_compiler() -> Option<String> {
    let mut candidates: Vec<String> = Vec::new();
    if cfg!(target_os = "macos") {
        for v in [15, 14, 13, 12] {
            candidates.push(format!("g++-{v}"));
            candidates.push(format!("/opt/homebrew/bin/g++-{v}"));
            candidates.push(format!("/usr/local/bin/g++-{v}"));
        }
    }
    candidates.push("g++".into());
    candidates.into_iter().find(|c| command_works(c))
}

pub fn find_python() -> Option<String> {
    let candidates = if cfg!(windows) {
        vec!["python", "python3"]
    } else {
        vec!["python3", "python"]
    };
    candidates
        .into_iter()
        .map(String::from)
        .find(|c| command_works(c))
}

#[tauri::command]
pub fn compile_file(path: String, flags: Option<Vec<String>>) -> Result<CompileResult, String> {
    let file = PathBuf::from(&path);
    if !file.exists() {
        return Err(format!("ファイルが見つかりません: {path}"));
    }
    let snapshot_id = take_snapshot(&file)?;
    let ext = file
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default();
    let stem = file
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "a".into());
    let dir = file.parent().unwrap_or(Path::new(".")).to_path_buf();

    match ext.as_str() {
        "cpp" | "cc" | "cxx" => {
            let compiler = find_cpp_compiler().ok_or(
                "C++コンパイラが見つかりません。「環境構築」ボタンからインストールしてください。",
            )?;
            let bin = dir.join(if cfg!(windows) {
                format!("{stem}.exe")
            } else {
                stem.clone()
            });
            // Settings may override the default flag set from the frontend.
            let user_flags: Vec<String> = match flags {
                Some(f) if !f.is_empty() => f,
                _ => ["-std=gnu++20", "-O2", "-Wall", "-Wextra"]
                    .iter()
                    .map(|s| s.to_string())
                    .collect(),
            };
            let out = Command::new(&compiler)
                .args(&user_flags)
                .arg("-o")
                .arg(&bin)
                .arg(&file)
                .output()
                .map_err(|e| format!("コンパイラ起動に失敗: {e}"))?;
            let mut output = String::from_utf8_lossy(&out.stderr).to_string();
            output.push_str(&String::from_utf8_lossy(&out.stdout));
            let run_cmd = if cfg!(windows) {
                format!(".\\{stem}.exe")
            } else {
                format!("./{stem}")
            };
            Ok(CompileResult {
                success: out.status.success(),
                output,
                compiler,
                run_cmd: out.status.success().then_some(run_cmd),
                snapshot_id,
            })
        }
        "py" => {
            let python = find_python().ok_or(
                "Pythonが見つかりません。「環境構築」ボタンからインストールしてください。",
            )?;
            let out = Command::new(&python)
                .args(["-m", "py_compile"])
                .arg(&file)
                .output()
                .map_err(|e| format!("Python起動に失敗: {e}"))?;
            let mut output = String::from_utf8_lossy(&out.stderr).to_string();
            output.push_str(&String::from_utf8_lossy(&out.stdout));
            if output.is_empty() && out.status.success() {
                output = "構文チェック OK".into();
            }
            let file_name = file
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or(path.clone());
            Ok(CompileResult {
                success: out.status.success(),
                output,
                compiler: python.clone(),
                run_cmd: out.status.success().then(|| format!("{python} {file_name}")),
                snapshot_id,
            })
        }
        other => Err(format!("未対応の拡張子です: .{other}")),
    }
}

#[tauri::command]
pub fn list_snapshots(path: String) -> Result<Vec<SnapshotInfo>, String> {
    let dir = snapshot_dir_for(Path::new(&path));
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut snaps: Vec<SnapshotInfo> = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|e| e.path().is_file())
        .filter_map(|e| {
            let p = e.path();
            let id = p.file_stem()?.to_string_lossy().to_string();
            id.parse::<u128>().ok()?;
            let size = e.metadata().ok()?.len();
            Some(SnapshotInfo { id, size })
        })
        .collect();
    snaps.sort_by(|a, b| b.id.parse::<u128>().unwrap().cmp(&a.id.parse::<u128>().unwrap()));
    Ok(snaps)
}

#[tauri::command]
pub fn read_snapshot(path: String, id: String) -> Result<String, String> {
    if !id.chars().all(|c| c.is_ascii_digit()) {
        return Err("不正なスナップショットIDです".into());
    }
    let dir = snapshot_dir_for(Path::new(&path));
    let entry = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .find(|p| {
            p.file_stem()
                .map(|s| s.to_string_lossy() == id.as_str())
                .unwrap_or(false)
        })
        .ok_or("スナップショットが見つかりません")?;
    fs::read_to_string(entry).map_err(|e| e.to_string())
}
