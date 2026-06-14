use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
};
use tauri::{
    webview::{NewWindowResponse, WebviewBuilder},
    Emitter, LogicalPosition, LogicalSize, Manager, State, WebviewUrl,
};

const CONTEST_WEBVIEW_LABEL_PREFIX: &str = "contest-webview";

#[derive(Debug, Serialize)]
struct EnvironmentPlan {
    os: String,
    package_manager: String,
    commands: Vec<SetupCommand>,
    notes: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupCommand {
    label: String,
    command: String,
    check: String,
    install: String,
    verify: String,
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
    cwd: String,
    command: String,
    status: i32,
    stdout: String,
    stderr: String,
    diff: String,
    executable_path: Option<String>,
}

#[derive(Debug, Serialize)]
struct RunResult {
    build: BuildResult,
    run: Option<CommandResult>,
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
#[serde(rename_all = "camelCase")]
struct ContestWebviewRequest {
    tab_id: String,
    url: String,
    navigate: Option<bool>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalStartRequest {
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
}

#[derive(Debug, Deserialize)]
struct TerminalInputRequest {
    data: String,
}

#[derive(Debug, Deserialize)]
struct TerminalResizeRequest {
    cols: u16,
    rows: u16,
}

#[derive(Debug, Clone, Serialize)]
struct TerminalOutputEvent {
    data: String,
}

#[derive(Default)]
struct TerminalState {
    session: Mutex<Option<TerminalSession>>,
}

struct TerminalSession {
    child: Box<dyn Child + Send>,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
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
          check: "Get-Command py -ErrorAction SilentlyContinue".to_string(),
          install: "winget install -e --id Python.Python.3.13".to_string(),
          verify: "py -3 --version".to_string(),
        },
        SetupCommand {
          label: "C++ toolchain".to_string(),
          command:
            "winget install -e --id MSYS2.MSYS2 && C:\\msys64\\usr\\bin\\pacman -S --needed mingw-w64-ucrt-x86_64-gcc"
              .to_string(),
          check: "Test-Path C:\\msys64\\ucrt64\\bin\\g++.exe".to_string(),
          install:
            "winget install -e --id MSYS2.MSYS2; C:\\msys64\\usr\\bin\\bash.exe -lc \"pacman -S --needed --noconfirm mingw-w64-ucrt-x86_64-gcc\""
              .to_string(),
          verify: "C:\\msys64\\ucrt64\\bin\\g++.exe --version".to_string(),
        },
        SetupCommand {
          label: "Rust".to_string(),
          command: "winget install -e --id Rustlang.Rustup".to_string(),
          check: "Get-Command rustc -ErrorAction SilentlyContinue".to_string(),
          install: "winget install -e --id Rustlang.Rustup".to_string(),
          verify: "rustc --version".to_string(),
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
          check: "xcode-select -p".to_string(),
          install: "xcode-select --install".to_string(),
          verify: "xcode-select -p".to_string(),
        },
        SetupCommand {
          label: "Python".to_string(),
          command: "brew install python".to_string(),
          check: "command -v python3".to_string(),
          install: "brew install python".to_string(),
          verify: "python3 --version".to_string(),
        },
        SetupCommand {
          label: "C++ compiler".to_string(),
          command: "brew install gcc".to_string(),
          check: "command -v g++-15 || command -v g++-14 || command -v g++".to_string(),
          install: "brew install gcc".to_string(),
          verify: "g++ --version".to_string(),
        },
        SetupCommand {
          label: "Rust".to_string(),
          command: "brew install rustup && rustup-init".to_string(),
          check: "command -v rustc".to_string(),
          install: "brew install rustup && rustup-init".to_string(),
          verify: "rustc --version".to_string(),
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
                    check: "command -v python3".to_string(),
                    install: "sudo apt update && sudo apt install -y python3 python3-pip"
                        .to_string(),
                    verify: "python3 --version".to_string(),
                },
                SetupCommand {
                    label: "C++ compiler".to_string(),
                    command: "sudo apt update && sudo apt install -y g++ build-essential"
                        .to_string(),
                    check: "command -v g++".to_string(),
                    install: "sudo apt update && sudo apt install -y g++ build-essential"
                        .to_string(),
                    verify: "g++ --version".to_string(),
                },
                SetupCommand {
                    label: "Rust".to_string(),
                    command: "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
                        .to_string(),
                    check: "command -v rustc".to_string(),
                    install: "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
                        .to_string(),
                    verify: "rustc --version".to_string(),
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
    let dir = root.join(&contest);
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
fn delete_path(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if path.is_dir() {
        fs::remove_dir_all(path).map_err(|err| err.to_string())
    } else {
        fs::remove_file(path).map_err(|err| err.to_string())
    }
}

#[tauri::command]
fn rename_path(path: String, new_path: String) -> Result<(), String> {
    fs::rename(PathBuf::from(path), PathBuf::from(new_path)).map_err(|err| err.to_string())
}

#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    let target = if path.exists() {
        path
    } else {
        path.parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "Path is not available.".to_string())?
    };

    let status = if cfg!(target_os = "macos") {
        Command::new("open").arg("-R").arg(target).status()
    } else if cfg!(target_os = "windows") {
        Command::new("explorer")
            .arg("/select,")
            .arg(target)
            .status()
    } else {
        let folder = if target.is_dir() {
            target
        } else {
            target
                .parent()
                .map(Path::to_path_buf)
                .ok_or_else(|| "Parent folder is not available.".to_string())?
        };
        Command::new("xdg-open").arg(folder).status()
    }
    .map_err(|err| err.to_string())?;

    if status.success() {
        Ok(())
    } else {
        Err("Failed to reveal path.".to_string())
    }
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
    let label = contest_webview_label(&request.tab_id);
    let position = LogicalPosition::new(request.x, request.y);
    let size = LogicalSize::new(request.width, request.height);

    hide_inactive_contest_webviews(&app, &label);

    if let Some(webview) = app.get_webview(&label) {
        if request.navigate.unwrap_or(true) {
            webview.navigate(url).map_err(|err| err.to_string())?;
            app.emit(
                "contest-webview-url",
                WebviewUrlEvent {
                    tab_id: request.tab_id.clone(),
                    url: request.url.clone(),
                },
            )
            .map_err(|err| err.to_string())?;
        }
        webview
            .set_position(position)
            .map_err(|err| err.to_string())?;
        webview.set_size(size).map_err(|err| err.to_string())?;
        webview.show().map_err(|err| err.to_string())?;
        return Ok(());
    }

    let app_for_new_window = app.clone();
    let app_for_navigation = app.clone();
    let new_window_label = label.clone();
    let navigation_tab_id = request.tab_id.clone();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(url))
        .devtools(false)
        .zoom_hotkeys_enabled(false)
        .on_navigation(move |url| {
            let allowed = allowed_atcoder_url(url.as_str());
            if allowed {
                let _ = app_for_navigation.emit(
                    "contest-webview-url",
                    WebviewUrlEvent {
                        tab_id: navigation_tab_id.clone(),
                        url: url.as_str().to_string(),
                    },
                );
            }
            allowed
        })
        .on_new_window(move |url, _features| {
            let url_text = url.as_str().to_string();
            if allowed_atcoder_url(&url_text) {
                if let Some(webview) = app_for_new_window.get_webview(&new_window_label) {
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
    let label = contest_webview_label(&request.tab_id);
    hide_inactive_contest_webviews(&app, &label);
    let Some(webview) = app.get_webview(&label) else {
        return Ok(());
    };

    webview
        .set_position(LogicalPosition::new(request.x, request.y))
        .map_err(|err| err.to_string())?;
    webview
        .set_size(LogicalSize::new(request.width, request.height))
        .map_err(|err| err.to_string())?;
    webview.show().map_err(|err| err.to_string())
}

#[tauri::command]
fn close_contest_webview(app: tauri::AppHandle, tab_id: Option<String>) -> Result<(), String> {
    if let Some(tab_id) = tab_id {
        let label = contest_webview_label(&tab_id);
        if let Some(webview) = app.get_webview(&label) {
            webview.close().map_err(|err| err.to_string())?;
        }
        return Ok(());
    }

    for webview in app.webviews().values() {
        if webview.label().starts_with(CONTEST_WEBVIEW_LABEL_PREFIX) {
            webview.close().map_err(|err| err.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn hide_contest_webviews(app: tauri::AppHandle) -> Result<(), String> {
    for webview in app.webviews().values() {
        if webview.label().starts_with(CONTEST_WEBVIEW_LABEL_PREFIX) {
            webview.hide().map_err(|err| err.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn contest_webview_back(app: tauri::AppHandle, tab_id: String) -> Result<(), String> {
    let label = contest_webview_label(&tab_id);
    if let Some(webview) = app.get_webview(&label) {
        webview
            .eval("history.back();")
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn contest_webview_forward(app: tauri::AppHandle, tab_id: String) -> Result<(), String> {
    let label = contest_webview_label(&tab_id);
    if let Some(webview) = app.get_webview(&label) {
        webview
            .eval("history.forward();")
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn hide_inactive_contest_webviews(app: &tauri::AppHandle, active_label: &str) {
    for webview in app.webviews().values() {
        let label = webview.label();
        if label.starts_with(CONTEST_WEBVIEW_LABEL_PREFIX) && label != active_label {
            let _ = webview.hide();
        }
    }
}

fn contest_webview_label(tab_id: &str) -> String {
    let suffix = tab_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .collect::<String>();
    if suffix.is_empty() {
        CONTEST_WEBVIEW_LABEL_PREFIX.to_string()
    } else {
        format!("{CONTEST_WEBVIEW_LABEL_PREFIX}-{suffix}")
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WebviewUrlEvent {
    tab_id: String,
    url: String,
}

#[tauri::command]
fn build_solution(request: BuildRequest) -> Result<BuildResult, String> {
    let (result, _) = build_solution_inner(request)?;
    Ok(result)
}

fn build_solution_inner(request: BuildRequest) -> Result<(BuildResult, Option<PathBuf>), String> {
    save_file(SaveFileRequest {
        path: request.path.clone(),
        content: request.content.clone(),
    })?;

    let path = PathBuf::from(&request.path);
    let source_dir = path
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "Source file directory is not available.".to_string())?;
    let diff = snapshot_diff(&path, &request.content)?;
    let language = normalize_language(&request.language);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("main");
    let cpp_fallback_file = if language == "cpp" {
        let mut target = source_dir.join(".accode");
        fs::create_dir_all(&target).map_err(|err| err.to_string())?;
        target.push(format!(".accode_bits_compat_{}.cpp", stem));
        if request.content.contains("#include <bits/stdc++.h>") {
            let fallback = cpp_source_with_fallback_bits(&request.content);
            if fallback != request.content {
                fs::write(&target, fallback).map_err(|err| err.to_string())?;
            }
            Some(target)
        } else {
            None
        }
    } else {
        None
    };
    let compile_path = cpp_fallback_file.as_ref().unwrap_or(&path);

    let bin_dir = source_dir.join(".accode").join("bin");
    fs::create_dir_all(&bin_dir).map_err(|err| err.to_string())?;
    let output_name = executable_name(stem);
    let output_path = bin_dir.join(output_name);

    let (program, args, command_text) =
        build_command(&language, compile_path, &output_path, &source_dir)?;
    let display_command = format!("cd {} && {command_text}", display_shell_path(&source_dir));
    let output = Command::new(program)
        .args(args)
        .current_dir(&source_dir)
        .output()
        .map_err(|err| err.to_string())?;
    let executable_path = if matches!(language.as_str(), "cpp" | "rust") && output.status.success()
    {
        Some(path_to_string(output_path.clone()))
    } else {
        None
    };

    Ok((
        BuildResult {
            file_path: path_to_string(path),
            cwd: path_to_string(source_dir),
            command: display_command,
            status: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            diff,
            executable_path,
        },
        if output.status.success() {
            Some(output_path)
        } else {
            None
        },
    ))
}

#[tauri::command]
fn run_solution(request: BuildRequest) -> Result<RunResult, String> {
    let language = normalize_language(&request.language);
    let (build, executable_path) = build_solution_inner(request)?;
    if build.status != 0 {
        return Ok(RunResult { build, run: None });
    }

    let cwd = PathBuf::from(&build.cwd);
    let run = if language == "python" {
        let program = if cfg!(target_os = "windows") {
            "py"
        } else {
            "python3"
        };
        let file_name = PathBuf::from(&build.file_path)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("main.py")
            .to_string();
        run_command(
            program,
            python_run_args(&file_name),
            &cwd,
            format!("{program} {file_name}"),
        )?
    } else {
        let executable = executable_path
            .as_ref()
            .ok_or_else(|| "Executable was not created.".to_string())?;
        let executable_name = executable
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("main")
            .to_string();
        let command_text = if cfg!(target_os = "windows") {
            format!(".\\{executable_name}")
        } else {
            format!("./{executable_name}")
        };
        run_command(executable, Vec::new(), &cwd, command_text)?
    };

    Ok(RunResult {
        build,
        run: Some(run),
    })
}

#[tauri::command]
fn run_terminal_command(command: String, cwd: Option<String>) -> Result<CommandResult, String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("Command is empty.".to_string());
    }
    let cwd = cwd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or(workspace_dir()?);

    let output = if cfg!(target_os = "windows") {
        Command::new("cmd")
            .args(["/C", trimmed])
            .current_dir(&cwd)
            .output()
    } else {
        Command::new("sh")
            .args(["-lc", trimmed])
            .current_dir(&cwd)
            .output()
    }
    .map_err(|err| err.to_string())?;

    Ok(CommandResult {
        command: format!("cd {} && {trimmed}", display_shell_path(&cwd)),
        status: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

#[tauri::command]
fn terminal_start(
    app: tauri::AppHandle,
    state: State<TerminalState>,
    request: TerminalStartRequest,
) -> Result<(), String> {
    let mut session = state.session.lock().map_err(|err| err.to_string())?;
    if session.is_some() {
        return Ok(());
    }

    let cwd = request
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or(default_workspace_dir()?);
    let cols = request.cols.unwrap_or(100).max(20);
    let rows = request.rows.unwrap_or(24).max(4);
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| err.to_string())?;

    let shell = default_shell();
    let mut command = CommandBuilder::new(shell);
    command.cwd(cwd);
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|err| err.to_string())?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|err| err.to_string())?;
    let writer = pair.master.take_writer().map_err(|err| err.to_string())?;
    let app_for_thread = app.clone();
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    let data = String::from_utf8_lossy(&buffer[..size]).to_string();
                    let _ = app_for_thread.emit("terminal-output", TerminalOutputEvent { data });
                }
                Err(_) => break,
            }
        }
    });

    *session = Some(TerminalSession {
        child,
        master: pair.master,
        writer,
    });
    Ok(())
}

#[tauri::command]
fn terminal_write(
    state: State<TerminalState>,
    request: TerminalInputRequest,
) -> Result<(), String> {
    let mut session = state.session.lock().map_err(|err| err.to_string())?;
    let Some(session) = session.as_mut() else {
        return Err("Terminal is not running.".to_string());
    };
    session
        .writer
        .write_all(request.data.as_bytes())
        .map_err(|err| err.to_string())?;
    session.writer.flush().map_err(|err| err.to_string())
}

#[tauri::command]
fn terminal_resize(
    state: State<TerminalState>,
    request: TerminalResizeRequest,
) -> Result<(), String> {
    let mut session = state.session.lock().map_err(|err| err.to_string())?;
    let Some(session) = session.as_mut() else {
        return Ok(());
    };
    session
        .master
        .resize(PtySize {
            rows: request.rows.max(4),
            cols: request.cols.max(20),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn terminal_stop(state: State<TerminalState>) -> Result<(), String> {
    let mut session = state.session.lock().map_err(|err| err.to_string())?;
    if let Some(mut session) = session.take() {
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
    Ok(())
}

#[tauri::command]
fn is_allowed_atcoder_url(url: String) -> bool {
    allowed_atcoder_url(&url)
}

fn build_command(
    language: &str,
    path: &Path,
    output_path: &Path,
    cwd: &Path,
) -> Result<(String, Vec<String>, String), String> {
    let path_text = relative_command_path(path, cwd);
    let output_text = relative_command_path(output_path, cwd);
    match language {
        "cpp" => {
            let compiler = cpp_compiler_program();
            Ok((
                compiler.clone(),
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
                format!(
                    "{compiler} -std=c++20 -O2 -Wall -Wextra -DLOCAL {path_text} -o {output_text}"
                ),
            ))
        }
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
                program.to_string(),
                args,
                if cfg!(target_os = "windows") {
                    format!("{program} -3 -m py_compile {path_text}")
                } else {
                    format!("{program} -m py_compile {path_text}")
                },
            ))
        }
        "rust" => Ok((
            "rustc".to_string(),
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

fn run_command(
    program: impl AsRef<std::ffi::OsStr>,
    args: Vec<String>,
    cwd: &Path,
    command_text: String,
) -> Result<CommandResult, String> {
    let output = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|err| err.to_string())?;

    Ok(CommandResult {
        command: format!("cd {} && {command_text}", display_shell_path(cwd)),
        status: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

fn python_run_args(file_name: &str) -> Vec<String> {
    if cfg!(target_os = "windows") {
        vec!["-3".to_string(), file_name.to_string()]
    } else {
        vec![file_name.to_string()]
    }
}

fn cpp_compiler_program() -> String {
    if cfg!(target_os = "windows") {
        let msys2_gpp = PathBuf::from(r"C:\msys64\ucrt64\bin\g++.exe");
        if msys2_gpp.exists() {
            return path_to_string(msys2_gpp);
        }
        return "g++".to_string();
    }

    for candidate in ["g++-15", "g++-14", "g++-13", "g++"] {
        if Command::new("sh")
            .args(["-lc", &format!("command -v {candidate}")])
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
        {
            return candidate.to_string();
        }
    }
    "g++".to_string()
}

fn executable_name(stem: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{stem}.exe")
    } else {
        stem.to_string()
    }
}

fn display_shell_path(path: &Path) -> String {
    let text = path_to_string(path.to_path_buf());
    if cfg!(target_os = "windows") {
        format!("\"{}\"", text.replace('"', "\\\""))
    } else {
        format!("'{}'", text.replace('\'', "'\\''"))
    }
}

fn relative_command_path(path: &Path, cwd: &Path) -> String {
    path.strip_prefix(cwd)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn snapshot_diff(path: &Path, content: &str) -> Result<String, String> {
    let snapshot_root = path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or(workspace_dir()?);
    let snapshot_dir = snapshot_root.join(".accode").join("snapshots");
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

    if old_lines == new_lines {
        return "No changes since previous build.".to_string();
    }

    let old_len = old_lines.len();
    let new_len = new_lines.len();
    if old_len.saturating_mul(new_len) > 1_000_000 {
        return positional_line_diff(&old_lines, &new_lines);
    }

    let width = new_len + 1;
    let mut dp = vec![0usize; (old_len + 1) * (new_len + 1)];

    for old_index in (0..old_len).rev() {
        for new_index in (0..new_len).rev() {
            let offset = old_index * width + new_index;
            dp[offset] = if old_lines[old_index] == new_lines[new_index] {
                dp[(old_index + 1) * width + new_index + 1] + 1
            } else {
                dp[(old_index + 1) * width + new_index].max(dp[old_index * width + new_index + 1])
            };
        }
    }

    let mut out = Vec::new();
    let mut old_index = 0;
    let mut new_index = 0;

    while old_index < old_len || new_index < new_len {
        if old_index < old_len
            && new_index < new_len
            && old_lines[old_index] == new_lines[new_index]
        {
            old_index += 1;
            new_index += 1;
        } else if new_index < new_len
            && (old_index == old_len
                || dp[old_index * width + new_index + 1] >= dp[(old_index + 1) * width + new_index])
        {
            out.push(format!("+ {:>4} {}", new_index + 1, new_lines[new_index]));
            new_index += 1;
        } else if old_index < old_len {
            out.push(format!("- {:>4} {}", old_index + 1, old_lines[old_index]));
            old_index += 1;
        }
    }

    if out.is_empty() {
        "No changes since previous build.".to_string()
    } else {
        out.join("\n")
    }
}

fn positional_line_diff(old_lines: &[&str], new_lines: &[&str]) -> String {
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
    if matches!(
        name,
        ".DS_Store"
            | ".accode"
            | ".atcode"
            | ".git"
            | "__pycache__"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | ".next"
    ) {
        return false;
    }

    if path.is_file() && path.extension().is_none() {
        return false;
    }

    true
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
        "python" => "def main() -> None:\n    pass\n\n\nif __name__ == \"__main__\":\n    main()\n"
            .to_string(),
        "rust" => "fn main() {\n}\n".to_string(),
        _ => "#if __has_include(<bits/stdc++.h>)\n#include <bits/stdc++.h>\n#else\n#include <algorithm>\n#include <array>\n#include <bitset>\n#include <cassert>\n#include <cctype>\n#include <chrono>\n#include <cmath>\n#include <cstdint>\n#include <deque>\n#include <fstream>\n#include <functional>\n#include <iomanip>\n#include <iostream>\n#include <iterator>\n#include <limits>\n#include <map>\n#include <memory>\n#include <numeric>\n#include <queue>\n#include <set>\n#include <sstream>\n#include <string>\n#include <tuple>\n#include <unordered_map>\n#include <unordered_set>\n#include <utility>\n#include <vector>\n#endif\nusing namespace std;\n\nint main() {\n}\n".to_string(),
    }
}

fn cpp_source_with_fallback_bits(content: &str) -> String {
    if !content.contains("#include <bits/stdc++.h>") {
        return content.to_string();
    }

    let fallback_header = r#"#if __has_include(<bits/stdc++.h>)
#include <bits/stdc++.h>
#else
#include <algorithm>
#include <array>
#include <bitset>
#include <cassert>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <deque>
#include <fstream>
#include <functional>
#include <iomanip>
#include <iostream>
#include <iterator>
#include <limits>
#include <map>
#include <memory>
#include <numeric>
#include <queue>
#include <set>
#include <sstream>
#include <string>
#include <tuple>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>
#endif
"#;

    content.replacen("#include <bits/stdc++.h>\n", fallback_header, 1)
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

fn default_shell() -> String {
    if cfg!(target_os = "windows") {
        "powershell.exe".to_string()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
    }
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
        .manage(TerminalState::default())
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
            delete_path,
            rename_path,
            reveal_path,
            open_contest_webview,
            set_contest_webview_bounds,
            close_contest_webview,
            hide_contest_webviews,
            contest_webview_back,
            contest_webview_forward,
            build_solution,
            run_solution,
            run_terminal_command,
            terminal_start,
            terminal_write,
            terminal_resize,
            terminal_stop,
            is_allowed_atcoder_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
