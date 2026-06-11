mod browser;
mod compile;
mod env_setup;
mod files;
mod pty;

use tauri::{Emitter, LogicalPosition, LogicalSize, WebviewUrl};

const INITIAL_URL: &str = "https://atcoder.jp/home?lang=ja";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(pty::PtyState::default())
        .invoke_handler(tauri::generate_handler![
            browser::set_browser_bounds,
            browser::set_browser_visible,
            browser::browser_navigate,
            browser::browser_back,
            browser::browser_forward,
            browser::browser_reload,
            browser::get_browser_url,
            files::workspace_dir,
            files::create_problem_file,
            files::read_file,
            files::save_file,
            files::list_workspace_files,
            files::read_dir,
            compile::compile_file,
            compile::list_snapshots,
            compile::read_snapshot,
            env_setup::env_check,
            pty::term_start,
            pty::term_write,
            pty::term_resize,
        ])
        .setup(|app| {
            files::ensure_workspace()?;

            let window = tauri::window::WindowBuilder::new(app, "main")
                .title("AtCode")
                .inner_size(1440.0, 900.0)
                .min_inner_size(1000.0, 620.0)
                .build()?;

            // Main UI webview: fills the window, hosts editor / terminal / toolbar.
            let ui = tauri::webview::WebviewBuilder::new("ui", WebviewUrl::App(Default::default()))
                .auto_resize();
            window.add_child(
                ui,
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(1440.0, 900.0),
            )?;

            // Browser webview: native view layered above the UI webview. The
            // frontend reports the rect of its placeholder pane and we move
            // this view to match. Navigation is restricted to AtCoder domains.
            let nav_handle = app.handle().clone();
            let browser = tauri::webview::WebviewBuilder::new(
                "browser",
                WebviewUrl::External(INITIAL_URL.parse().unwrap()),
            )
            .on_navigation(move |url| {
                let allowed = browser::is_allowed_url(url);
                if !allowed {
                    let _ = nav_handle.emit("browser:blocked", url.to_string());
                }
                allowed
            })
            .on_page_load(|webview, payload| {
                if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                    let _ = webview.emit("browser:nav", payload.url().to_string());
                }
            });
            window.add_child(
                browser,
                LogicalPosition::new(760.0, 76.0),
                LogicalSize::new(680.0, 790.0),
            )?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
