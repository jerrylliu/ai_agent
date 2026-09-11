// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod commands;

// Manager 仅桌面端 setup 使用（移动端跳过标题栏创建）
#[cfg(desktop)]
use tauri::Manager;
// decorum 自定义标题栏仅桌面端使用（移动端主窗口由原生 Activity 承载）
#[cfg(desktop)]
use tauri_plugin_decorum::WebviewWindowExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_decorum::init())
        // 自动更新仅桌面端有意义（安卓系统禁止应用静默自装，由前端跳浏览器下载 APK）
        .setup(|app| {
            // 创建自定义标题栏：Windows 上隐藏系统装饰并创建自定义窗口控制按钮
            // macOS 上使用 hiddenTitle + titleBarStyle: overlay
            // 移动端无系统窗口装饰概念，跳过
            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
                let main_window = app.get_webview_window("main").unwrap();
                main_window.create_overlay_titlebar().unwrap();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::greet,
            commands::chat,
            commands::test,
            commands::open_editor_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
