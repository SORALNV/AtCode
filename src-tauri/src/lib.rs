use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::{
    webview::{NewWindowResponse, WebviewBuilder},
    Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl,
};

const CONTEST_WEBVIEW_LABEL: &str = "contest-webview";

#[derive(Debug, Serialize)]
struct EnvironmentPlan {
    os: String,
    package_manager: String,
    commands: Vec<SetupCommand>,
    notes: Vec<String>,
}

#[derive(Debug, Serialize)]
struct SetupCommand {
    label: String,
    command: String,
}

#[derive(Debug, Serialize)]
struct SolutionFile {
    path: String,
    content: String,
    language: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExplorerNode {
    name: String,
    path: String,
    is_dir: bool,
    children: Vec<ExplorerNode>,
}

#[derive(Debug, Serialize)]
struct CommandResult {
    command: String,
    status: i32,
    stdout: String,
    stderr: String,
}

#[derive(Debug, Serialize)]
struct BuildResult {
    file_path: String,
    command: String,
    status: i32,
    stdout: String,
    stderr: String,
    diff: String,
}

#[derive(Debug, Deserialize)]
struct CreateSolutionRequest {
    contest: String,
    problem: String,
    language: String,
    workspace_path: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SaveFileRequest {
    path: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct BuildRequest {
    path: String,
    content: String,
    language: String,
}

#[derive(Debug, Deserialize)]
struct ContestWebviewRequest {
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[tauri::command]
fn get_environment_plan() -> EnvironmentPlan {
    if cfg!(target_os = "windows") {
        EnvironmentPlan {
      os: "Windows".to_string(),
      package_manager: "winget + MSYS2".to_string(),
      commands: vec![
        SetupCommand {
          label: "Python".to_string(),
          command: "winget install -e --id Python.Python.3.13".to_string(),
        },
        SetupCommand {
          label: "C++ toolchain".to_string(),
          command:
            "winget install -e --id MSYS2.MSYS2 && C:\\msys64\\usr\\bin\\pacman -S --needed mingw-w64-ucrt-x86_64-gcc"
              .to_string(),
        },
        SetupCommand {
          label: "Rust".to_string(),
          command: "winget install -e --id Rustlang.Rustup".to_string(),
        },
      ],
      notes: vec![
        "MSYS2 の UCRT64 shell で g++ に PATH を通すと AtCoder の C++ 環境に近づきます。"
          .to_string(),
        "VSCode 拡張機能互換は別途 extension host が必要です。".to_string(),
      ],
    }
    } else if cfg!(target_os = "macos") {
        EnvironmentPlan {
      os: "macOS".to_string(),
      package_manager: "Homebrew + Xcode Command Line Tools".to_string(),
      commands: vec![
        SetupCommand {
          label: "Xcode CLI".to_string(),
          command: "xcode-select --install".to_string(),
        },
        SetupCommand {
          label: "Python".to_string(),
          command: "brew install python".to_string(),
        },
        SetupCommand {
          label: "C++ compiler".to_string(),
          command: "brew install gcc".to_string(),
        },
        SetupCommand {
          label: "Rust".to_string(),
          command: "brew install rustup && rustup-init".to_string(),
        },
      ],
      notes: vec![
        "AtCoder の C++ は g++ を前提にすると差異が少なくなります。".to_string(),
        "Chrome 拡張機能を完全互換にするには Tauri 標準 WebView ではなく CEF/外部 Chrome 連携が必要です。"
          .to_string(),
      ],
    }
    } else {
        EnvironmentPlan {
            os: "Linux".to_string(),
            package_manager: "apt".to_string(),
            commands: vec![
                SetupCommand {
                    label: "Python".to_string(),
                    command: "sudo apt update && sudo apt install -y python3 python3-pip"
                        .to_string(),
                },
                SetupCommand {
                    label: "C++ compiler".to_string(),
                    command: "sudo apt update && sudo apt install -y g++ build-essential"
                        .to_string(),
                },
                SetupCommand {
                    label: "Rust".to_string(),
                    command: "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
                        .to_string(),
                },
            ],
            notes: vec![
                "ディストリビューションに合わせて apt を dnf/pacman に置き換えてください。"
                    .to_string(),
            ],
        }
    }
}

#[tauri::command]
fn create_solution_file(request: CreateSolutionRequest) -> Result<SolutionFile, String> {
    let contest = normalize_token_lowercase(&request.contest, "abc423");
    let problem = normalize_optional_token_lowercase(&request.problem);
    let language = normalize_language(&request.language);
    let ext = extension_for(&language);
    let file_name = if problem.is_empty() {
        format!("{contest}.{ext}")
    } else {
        format!("{contest}_{problem}.{ext}")
    };
    let root = request
        .workspace_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or(default_workspace_dir()?);
    let dir = root.join("contests").join(&contest);
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let path = dir.join(file_name);
    let content = template_for(&language);
    if !path.exists() {
        fs::write(&path, &content).map_err(|err| err.to_string())?;
    }
    let content = fs::read_to_string(&path).unwrap_or(content);

    Ok(SolutionFile {
        path: path_to_string(path),
        content,
        language,
    })
}

#[tauri::command]
fn read_source_file(path: String) -> Result<SolutionFile, String> {
    let path = PathBuf::from(path);
    let content = fs::read_to_string(&path).map_err(|err| err.to_string())?;
    let language = language_for_path(&path);

    Ok(SolutionFile {
        path: path_to_string(path),
        content,
        language,
    })
}

#[tauri::command]
fn read_folder_tree(path: String) -> Result<ExplorerNode, String> {
    let path = PathBuf::from(path);
    if !path.is_dir() {
        return Err("Selected path is not a folder.".to_string());
    }

    let mut remaining = 600;
    build_explorer_node(&path, 0, &mut remaining)
}

#[tauri::command]
fn save_file(request: SaveFileRequest) -> Result<(), String> {
    let path = PathBuf::from(&request.path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(path, request.content).map_err(|err| err.to_string())
}

#[tauri::command]
fn create_folder(path: String) -> Result<(), String> {
    fs::create_dir_all(PathBuf::from(path)).map_err(|err| err.to_string())
}

#[tauri::command]
fn open_contest_webview(
    app: tauri::AppHandle,
    window: tauri::Window,
    request: ContestWebviewRequest,
) -> Result<(), String> {
    if !allowed_atcoder_url(&request.url) {
        return Err("AtCoder or Problems URL is required.".to_string());
    }

    let url = tauri::Url::parse(&request.url).map_err(|err| err.to_string())?;
    let position = LogicalPosition::new(request.x, request.y);
    let size = LogicalSize::new(request.width, request.height);

    if let Some(webview) = app.get_webview(CONTEST_WEBVIEW_LABEL) {
        webview.navigate(url).map_err(|err| err.to_string())?;
        app.emit("contest-webview-url", request.url.clone())
            .map_err(|err| err.to_string())?;
        webview
            .set_position(position)
            .map_err(|err| err.to_string())?;
        webview.set_size(size).map_err(|err| err.to_string())?;
        webview.show().map_err(|err| err.to_string())?;
        return Ok(());
    }

    let app_for_new_window = app.clone();
    let app_for_navigation = app.clone();
    let builder = WebviewBuilder::new(CONTEST_WEBVIEW_LABEL, WebviewUrl::External(url))
        .devtools(false)
        .zoom_hotkeys_enabled(false)
        .on_navigation(move |url| {
            let allowed = allowed_atcoder_url(url.as_str());
            if allowed {
                let _ = app_for_navigation.emit("contest-webview-url", url.as_str().to_string());
            }
            allowed
        })
        .on_new_window(move |url, _features| {
            let url_text = url.as_str().to_string();
            if allowed_atcoder_url(&url_text) {
                if let Some(webview) = app_for_new_window.get_webview(CONTEST_WEBVIEW_LABEL) {
                    let _ = webview.navigate(url);
                }
            }
            NewWindowResponse::Deny
        });

    window
        .add_child(builder, position, size)
        .map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
fn set_contest_webview_bounds(
    app: tauri::AppHandle,
    request: ContestWebviewRequest,
) -> Result<(), String> {
    let Some(webview) = app.get_webview(CONTEST_WEBVIEW_LABEL) else {
        return Ok(());
    };

    webview
        .set_position(LogicalPosition::new(request.x, request.y))
        .map_err(|err| err.to_string())?;
    webview
        .set_size(LogicalSize::new(request.width, request.height))
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn close_contest_webview(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(webview) = app.get_webview(CONTEST_WEBVIEW_LABEL) {
        webview.close().map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn contest_webview_back(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(webview) = app.get_webview(CONTEST_WEBVIEW_LABEL) {
        webview
            .eval("history.back();")
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn contest_webview_forward(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(webview) = app.get_webview(CONTEST_WEBVIEW_LABEL) {
        webview
            .eval("history.forward();")
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn build_solution(request: BuildRequest) -> Result<BuildResult, String> {
    save_file(SaveFileRequest {
        path: request.path.clone(),
        content: request.content.clone(),
    })?;

    let path = PathBuf::from(&request.path);
    let diff = snapshot_diff(&path, &request.content)?;
    let language = normalize_language(&request.language);
    let bin_dir = workspace_dir()?.join(".accode").join("bin");
    fs::create_dir_all(&bin_dir).map_err(|err| err.to_string())?;
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("main");
    let output_path = bin_dir.join(stem);

    let (program, args, command_text) = build_command(&language, &path, &output_path)?;
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|err| err.to_string())?;

    Ok(BuildResult {
        file_path: path_to_string(path),
        command: command_text,
        status: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        diff,
    })
}

#[tauri::command]
fn run_terminal_command(command: String) -> Result<CommandResult, String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("Command is empty.".to_string());
    }

    let output = if cfg!(target_os = "windows") {
        Command::new("cmd")
            .args(["/C", trimmed])
            .current_dir(workspace_dir()?)
            .output()
    } else {
        Command::new("sh")
            .args(["-lc", trimmed])
            .current_dir(workspace_dir()?)
            .output()
    }
    .map_err(|err| err.to_string())?;

    Ok(CommandResult {
        command: trimmed.to_string(),
        status: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

#[tauri::command]
fn is_allowed_atcoder_url(url: String) -> bool {
    allowed_atcoder_url(&url)
}

fn build_command(
    language: &str,
    path: &Path,
    output_path: &Path,
) -> Result<(&'static str, Vec<String>, String), String> {
    let path_text = path_to_string(path.to_path_buf());
    let output_text = path_to_string(output_path.to_path_buf());
    match language {
        "cpp" => Ok((
            "g++",
            vec![
                "-std=c++20".to_string(),
                "-O2".to_string(),
                "-Wall".to_string(),
                "-Wextra".to_string(),
                "-DLOCAL".to_string(),
                path_text.clone(),
                "-o".to_string(),
                output_text.clone(),
            ],
            format!("g++ -std=c++20 -O2 -Wall -Wextra -DLOCAL {path_text} -o {output_text}"),
        )),
        "python" => {
            let program = if cfg!(target_os = "windows") {
                "py"
            } else {
                "python3"
            };
            let args = if cfg!(target_os = "windows") {
                vec![
                    "-3".to_string(),
                    "-m".to_string(),
                    "py_compile".to_string(),
                    path_text.clone(),
                ]
            } else {
                vec![
                    "-m".to_string(),
                    "py_compile".to_string(),
                    path_text.clone(),
                ]
            };
            Ok((
                program,
                args,
                format!("{program} -m py_compile {path_text}"),
            ))
        }
        "rust" => Ok((
            "rustc",
            vec![
                "--edition=2021".to_string(),
                "-O".to_string(),
                path_text.clone(),
                "-o".to_string(),
                output_text.clone(),
            ],
            format!("rustc --edition=2021 -O {path_text} -o {output_text}"),
        )),
        _ => Err("Unsupported language.".to_string()),
    }
}

fn snapshot_diff(path: &Path, content: &str) -> Result<String, String> {
    let snapshot_dir = workspace_dir()?.join(".accode").join("snapshots");
    fs::create_dir_all(&snapshot_dir).map_err(|err| err.to_string())?;
    let key = sanitize_snapshot_key(&path_to_string(path.to_path_buf()));
    let snapshot_path = snapshot_dir.join(format!("{key}.last"));
    let previous = fs::read_to_string(&snapshot_path).unwrap_or_default();
    fs::write(snapshot_path, content).map_err(|err| err.to_string())?;

    if previous.is_empty() {
        return Ok("Initial build snapshot created.".to_string());
    }
    Ok(line_diff(&previous, content))
}

fn line_diff(previous: &str, current: &str) -> String {
    let old_lines: Vec<&str> = previous.lines().collect();
    let new_lines: Vec<&str> = current.lines().collect();
    let max_len = old_lines.len().max(new_lines.len());
    let mut out = Vec::new();

    for index in 0..max_len {
        match (old_lines.get(index), new_lines.get(index)) {
            (Some(old), Some(new)) if old == new => {}
            (Some(old), Some(new)) => {
                out.push(format!("- {:>4} {}", index + 1, old));
                out.push(format!("+ {:>4} {}", index + 1, new));
            }
            (Some(old), None) => out.push(format!("- {:>4} {}", index + 1, old)),
            (None, Some(new)) => out.push(format!("+ {:>4} {}", index + 1, new)),
            (None, None) => {}
        }
    }

    if out.is_empty() {
        "No changes since previous build.".to_string()
    } else {
        out.join("\n")
    }
}

fn workspace_dir() -> Result<PathBuf, String> {
    std::env::current_dir().map_err(|err| err.to_string())
}

fn default_workspace_dir() -> Result<PathBuf, String> {
    let home = if cfg!(target_os = "windows") {
        std::env::var_os("USERPROFILE")
    } else {
        std::env::var_os("HOME")
    }
    .ok_or_else(|| "Home directory is not available.".to_string())?;

    Ok(PathBuf::from(home).join("AtCode"))
}

fn build_explorer_node(
    path: &Path,
    depth: usize,
    remaining: &mut usize,
) -> Result<ExplorerNode, String> {
    let is_dir = path.is_dir();
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_else(|| path.to_str().unwrap_or("Folder"))
        .to_string();
    let mut node = ExplorerNode {
        name,
        path: path_to_string(path.to_path_buf()),
        is_dir,
        children: Vec::new(),
    };

    if !is_dir || depth >= 5 || *remaining == 0 {
        return Ok(node);
    }

    let mut entries = fs::read_dir(path)
        .map_err(|err| err.to_string())?
        .filter_map(Result::ok)
        .filter(|entry| should_show_in_explorer(&entry.path()))
        .collect::<Vec<_>>();

    entries.sort_by(|left, right| {
        let left_path = left.path();
        let right_path = right.path();
        let left_is_dir = left_path.is_dir();
        let right_is_dir = right_path.is_dir();
        right_is_dir
            .cmp(&left_is_dir)
            .then_with(|| left.file_name().cmp(&right.file_name()))
    });

    for entry in entries {
        if *remaining == 0 {
            break;
        }
        *remaining -= 1;
        node.children
            .push(build_explorer_node(&entry.path(), depth + 1, remaining)?);
    }

    Ok(node)
}

fn should_show_in_explorer(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    !matches!(
        name,
        ".DS_Store" | ".git" | "node_modules" | "target" | "dist" | "build" | ".next"
    )
}

fn normalize_token_lowercase(value: &str, fallback: &str) -> String {
    let normalized: String = value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '-')
        .collect::<String>()
        .to_ascii_lowercase();
    if normalized.is_empty() {
        fallback.to_string()
    } else {
        normalized
    }
}

fn normalize_optional_token_lowercase(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '-')
        .collect::<String>()
        .to_ascii_lowercase()
}

fn normalize_language(value: &str) -> String {
    match value.to_ascii_lowercase().as_str() {
        "py" | "python" | "python3" => "python".to_string(),
        "rs" | "rust" => "rust".to_string(),
        _ => "cpp".to_string(),
    }
}

fn extension_for(language: &str) -> &'static str {
    match language {
        "python" => "py",
        "rust" => "rs",
        _ => "cpp",
    }
}

fn language_for_path(path: &Path) -> String {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    normalize_language(extension)
}

fn template_for(language: &str) -> String {
    match language {
    "python" => "import sys\n\n\ndef main() -> None:\n    input = sys.stdin.readline\n    n = input().strip()\n    print(n)\n\n\nif __name__ == \"__main__\":\n    main()\n".to_string(),
    "rust" => "use std::io::{self, Read};\n\nfn main() {\n    let mut input = String::new();\n    io::stdin().read_to_string(&mut input).unwrap();\n    println!(\"{}\", input.trim());\n}\n".to_string(),
    _ => "#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    ios::sync_with_stdio(false);\n    cin.tie(nullptr);\n\n    string s;\n    cin >> s;\n    cout << s << '\\n';\n    return 0;\n}\n".to_string(),
  }
}

fn sanitize_snapshot_key(value: &str) -> String {
    value
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' })
        .collect()
}

fn path_to_string(path: PathBuf) -> String {
    path.to_string_lossy().to_string()
}

fn allowed_atcoder_url(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    lower == "https://atcoder.jp"
        || lower.starts_with("https://atcoder.jp/")
        || lower.starts_with("https://www.atcoder.jp/")
        || lower == "https://atcoder-problems.com"
        || lower.starts_with("https://atcoder-problems.com/")
        || lower.starts_with("https://www.atcoder-problems.com/")
        || lower == "https://kenkoooo.com/atcoder"
        || lower.starts_with("https://kenkoooo.com/atcoder/")
        || allowed_auth_url(&lower)
}

fn allowed_auth_url(lower: &str) -> bool {
    let Some(path_start) = lower
        .strip_prefix("https://github.com")
        .or_else(|| lower.strip_prefix("https://www.github.com"))
    else {
        return false;
    };

    path_start == "/login"
        || path_start.starts_with("/login?")
        || path_start == "/session"
        || path_start.starts_with("/session?")
        || path_start.starts_with("/sessions")
        || path_start.starts_with("/login/oauth")
        || path_start.starts_with("/password_reset")
        || path_start.starts_with("/account_verifications")
        || path_start.starts_with("/webauthn")
        || path_start.starts_with("/u2f")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_environment_plan,
            create_solution_file,
            read_source_file,
            read_folder_tree,
            save_file,
            create_folder,
            open_contest_webview,
            set_contest_webview_bounds,
            close_contest_webview,
            contest_webview_back,
            contest_webview_forward,
            build_solution,
            run_terminal_command,
            is_allowed_atcoder_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
