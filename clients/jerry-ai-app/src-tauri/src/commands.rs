use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_decorum::WebviewWindowExt;

#[tauri::command]
pub fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}
#[tauri::command]
pub fn chat(message: &str) -> String {
    format!("You said: {}", message)
}

#[tauri::command]
pub fn test() -> String {
    format!("test")
}

/// 打开编辑器独立窗口
///
/// - `document_id`: 文档 ID；不传则进入草稿模式（label = `editor-new-{timestamp}`）
/// - `title`: 窗口标题，不传时使用默认值
/// - `transient_token`: 跨窗口传递内容的 token，会被附加到 URL query
///
/// 行为：
/// - 同一 documentId 的窗口已存在时 → 激活前置而非重复创建
/// - 草稿窗口每次都新建（label 带时间戳）
/// - 默认尺寸 1200x800，最小 800x600，居中显示
#[tauri::command]
pub async fn open_editor_window(
    app: AppHandle,
    document_id: Option<i64>,
    title: Option<String>,
    transient_token: Option<String>,
) -> Result<String, String> {
    let label = match document_id {
        Some(id) => format!("editor-doc-{}", id),
        None => format!(
            "editor-new-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ),
    };

    // 已存在则激活前置
    if let Some(existing) = app.get_webview_window(&label) {
        existing.set_focus().map_err(|e| e.to_string())?;
        existing.unminimize().ok();
        return Ok(label);
    }

    // 构造 hash 路由路径
    // hash 内部约定：#/editor/{id}?windowMode=standalone&transientToken=xxx
    // router.ts parseHash 会从 hash 的 ? 之后解析 query
    let token_param = match &transient_token {
        Some(t) => format!("&transientToken={}", t),
        None => String::new(),
    };
    let route_path = match document_id {
        Some(id) => format!("/#/editor/{}?windowMode=standalone{}", id, token_param),
        None => format!("/#/editor/new?windowMode=standalone{}", token_param),
    };

    let window_title = title.unwrap_or_else(|| "文档编辑器 - 以太忆核".to_string());

    let editor_window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(route_path.into()))
        .title(window_title)
        .inner_size(1200.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .center()
        .resizable(true)
        // 与主窗口一致：隐藏系统装饰，使用 decorum 自定义标题栏
        .decorations(false)
        .build()
        .map_err(|e| e.to_string())?;

    // 创建自定义标题栏（窗口控制按钮由 decorum 插件注入到 webview 内）
    editor_window.create_overlay_titlebar().unwrap();

    Ok(label)
}
