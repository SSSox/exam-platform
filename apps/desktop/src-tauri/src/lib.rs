// The shell hosts the web UI: content, grading and progress all live in the shared TypeScript core.
// Its one native job on the desktop is updating the app itself (update.rs); Android does that in MainActivity.kt.
#[cfg(desktop)]
mod update;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(update::Pending::default())
        .invoke_handler(tauri::generate_handler![update::update_enabled, update::update_check, update::update_install]);
    builder
        .run(tauri::generate_context!())
        .expect("failed to start the application");
}
