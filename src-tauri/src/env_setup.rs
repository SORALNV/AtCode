use crate::compile;
use serde::Serialize;
use std::process::Command;

#[derive(Serialize)]
pub struct ToolStatus {
    pub id: String,
    pub name: String,
    pub found: bool,
    pub detail: String,
    pub install_cmd: String,
    pub note: String,
}

#[derive(Serialize)]
pub struct EnvReport {
    pub os: String,
    pub items: Vec<ToolStatus>,
}

fn version_line(cmd: &str, arg: &str) -> Option<String> {
    let out = Command::new(cmd).arg(arg).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = if out.stdout.is_empty() {
        out.stderr
    } else {
        out.stdout
    };
    String::from_utf8_lossy(&text)
        .lines()
        .next()
        .map(|s| s.trim().to_string())
}

#[tauri::command]
pub fn env_check() -> EnvReport {
    let os = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    };
    let mut items = Vec::new();

    if os == "macos" {
        let brew = version_line("brew", "--version");
        items.push(ToolStatus {
            id: "brew".into(),
            name: "Homebrew".into(),
            found: brew.is_some(),
            detail: brew.unwrap_or_else(|| "未インストール".into()),
            install_cmd: r#"/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)""#.into(),
            note: "macOSのパッケージマネージャ。GCC/Pythonのインストールに必要です。".into(),
        });
    }

    // C++ (GCC)
    let gxx = compile::find_cpp_compiler();
    let (gxx_found, gxx_detail) = match &gxx {
        Some(c) => {
            let ver = version_line(c, "--version").unwrap_or_default();
            if ver.to_lowercase().contains("clang") {
                (false, format!("{ver}(Apple clangはbits/stdc++.h非対応のためGCC推奨)"))
            } else {
                (true, format!("{c}: {ver}"))
            }
        }
        None => (false, "未インストール".into()),
    };
    items.push(ToolStatus {
        id: "gcc".into(),
        name: "C++ (GCC)".into(),
        found: gxx_found,
        detail: gxx_detail,
        install_cmd: match os {
            "macos" => "brew install gcc".into(),
            "windows" => "winget install -e --id MSYS2.MSYS2".into(),
            _ => "sudo apt install -y g++".into(),
        },
        note: match os {
            "windows" => "インストール後、MSYS2のターミナルで「pacman -S mingw-w64-ucrt-x86_64-gcc」を実行し、C:\\msys64\\ucrt64\\bin をPATHに追加してください。".into(),
            _ => "AtCoderのジャッジ環境と同じGCCを使います。".into(),
        },
    });

    // Python
    let py = compile::find_python();
    let py_detail = py
        .as_ref()
        .and_then(|p| version_line(p, "--version"))
        .unwrap_or_else(|| "未インストール".into());
    items.push(ToolStatus {
        id: "python".into(),
        name: "Python 3".into(),
        found: py.is_some(),
        detail: py_detail,
        install_cmd: match os {
            "macos" => "brew install python".into(),
            "windows" => "winget install -e --id Python.Python.3.12".into(),
            _ => "sudo apt install -y python3".into(),
        },
        note: "PyPy派の人はインストール後に好みで切り替えてください。".into(),
    });

    EnvReport {
        os: os.into(),
        items,
    }
}
