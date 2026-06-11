use crate::files;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct PtyState(Mutex<Option<Session>>);

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

fn e2s(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn shell_command() -> CommandBuilder {
    let mut cmd = if cfg!(windows) {
        CommandBuilder::new("powershell.exe")
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let mut c = CommandBuilder::new(shell);
        // Login shell so the user's PATH (Homebrew etc.) is loaded.
        c.arg("-l");
        c
    };
    cmd.cwd(files::workspace_path());
    cmd.env("TERM", "xterm-256color");
    cmd
}

#[tauri::command]
pub fn term_start(
    app: AppHandle,
    state: State<PtyState>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    if let Some(session) = guard.as_mut() {
        let alive = session.child.try_wait().map(|s| s.is_none()).unwrap_or(false);
        if alive {
            return Ok(());
        }
    }

    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(e2s)?;
    let child = pair.slave.spawn_command(shell_command()).map_err(e2s)?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(e2s)?;
    let writer = pair.master.take_writer().map_err(e2s)?;

    let handle = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        // Carry over bytes of multi-byte characters split across reads.
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => {
                    let _ = handle.emit("term:exit", ());
                    break;
                }
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    match std::str::from_utf8(&pending) {
                        Ok(s) => {
                            let _ = handle.emit("term:data", s.to_string());
                            pending.clear();
                        }
                        Err(err) => {
                            let valid = err.valid_up_to();
                            if valid > 0 {
                                let s = String::from_utf8_lossy(&pending[..valid]).to_string();
                                let _ = handle.emit("term:data", s);
                                pending.drain(..valid);
                            }
                            if pending.len() > 4 {
                                let s = String::from_utf8_lossy(&pending).to_string();
                                let _ = handle.emit("term:data", s);
                                pending.clear();
                            }
                        }
                    }
                }
            }
        }
    });

    *guard = Some(Session {
        master: pair.master,
        writer,
        child,
    });
    Ok(())
}

#[tauri::command]
pub fn term_write(state: State<PtyState>, data: String) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    let session = guard.as_mut().ok_or("ターミナルが起動していません")?;
    session.writer.write_all(data.as_bytes()).map_err(e2s)?;
    session.writer.flush().map_err(e2s)
}

#[tauri::command]
pub fn term_resize(state: State<PtyState>, cols: u16, rows: u16) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    let session = guard.as_mut().ok_or("ターミナルが起動していません")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(e2s)
}
