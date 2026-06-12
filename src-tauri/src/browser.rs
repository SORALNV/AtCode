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
    // Clamp to the window's inner area: a webview that pokes past the window
    // edge shows up as clipped page content.
    let win = wv.window();
    let scale = win.scale_factor().map_err(e2s)?;
    let inner = win.inner_size().map_err(e2s)?.to_logical::<f64>(scale);
    let x = x.clamp(0.0, (inner.width - 1.0).max(0.0));
    let y = y.clamp(0.0, (inner.height - 1.0).max(0.0));
    let width = width.max(1.0).min(inner.width - x);
    let height = height.max(1.0).min(inner.height - y);
    // Atomic position+size update; setting them separately could leave the
    // webview half-updated (seen as a dark gap under the page).
    wv.set_bounds(tauri::Rect {
        position: LogicalPosition::new(x, y).into(),
        size: LogicalSize::new(width, height).into(),
    })
    .map_err(e2s)
}

/// Actual bounds as the OS reports them (logical px), so the frontend can
/// detect drift and re-apply.
#[tauri::command]
pub fn get_browser_bounds(app: AppHandle) -> Result<(f64, f64, f64, f64), String> {
    let wv = browser(&app)?;
    let scale = wv.window().scale_factor().map_err(e2s)?;
    let pos = wv.position().map_err(e2s)?.to_logical::<f64>(scale);
    let size = wv.size().map_err(e2s)?.to_logical::<f64>(scale);
    Ok((pos.x, pos.y, size.width, size.height))
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
