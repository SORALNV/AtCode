use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Url};

/// Only AtCoder itself and AtCoder Problems (kenkoooo.com) may be displayed.
pub fn is_allowed_url(url: &Url) -> bool {
    match url.scheme() {
        "https" | "http" => {}
        "about" => return true,
        _ => return false,
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    ["atcoder.jp", "kenkoooo.com"]
        .iter()
        .any(|d| host == *d || host.ends_with(&format!(".{d}")))
}

fn browser(app: &AppHandle) -> Result<tauri::Webview, String> {
    app.get_webview("browser")
        .ok_or_else(|| "browser webview not found".to_string())
}

fn e2s(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[tauri::command]
pub fn set_browser_bounds(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let wv = browser(&app)?;
    wv.set_position(LogicalPosition::new(x, y)).map_err(e2s)?;
    wv.set_size(LogicalSize::new(width.max(1.0), height.max(1.0)))
        .map_err(e2s)?;
    Ok(())
}

#[tauri::command]
pub fn set_browser_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    let wv = browser(&app)?;
    if visible {
        wv.show().map_err(e2s)
    } else {
        wv.hide().map_err(e2s)
    }
}

#[tauri::command]
pub fn browser_navigate(app: AppHandle, url: String) -> Result<(), String> {
    let parsed: Url = url.parse().map_err(e2s)?;
    if !is_allowed_url(&parsed) {
        return Err("AtCoder / AtCoder Problems 以外のサイトは開けません".into());
    }
    browser(&app)?.navigate(parsed).map_err(e2s)
}

#[tauri::command]
pub fn browser_back(app: AppHandle) -> Result<(), String> {
    browser(&app)?.eval("history.back()").map_err(e2s)
}

#[tauri::command]
pub fn browser_forward(app: AppHandle) -> Result<(), String> {
    browser(&app)?.eval("history.forward()").map_err(e2s)
}

#[tauri::command]
pub fn browser_reload(app: AppHandle) -> Result<(), String> {
    browser(&app)?.eval("location.reload()").map_err(e2s)
}

#[tauri::command]
pub fn get_browser_url(app: AppHandle) -> Result<String, String> {
    browser(&app)?.url().map(|u| u.to_string()).map_err(e2s)
}
