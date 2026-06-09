// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod commands;

use tauri::Manager;
use tauri_plugin_decorum::WebviewWindowExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_decorum::init())
        .setup(|app| {
            // 创建自定义标题栏：Windows 上隐藏系统装饰并创建自定义窗口控制按钮
            // macOS 上使用 hiddenTitle + titleBarStyle: overlay
            let main_window = app.get_webview_window("main").unwrap();
            main_window.create_overlay_titlebar().unwrap();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![commands::greet, commands::chat, commands::test])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
