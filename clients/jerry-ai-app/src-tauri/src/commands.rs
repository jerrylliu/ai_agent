
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
