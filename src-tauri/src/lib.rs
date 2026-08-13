pub mod app;
pub mod autologin;
pub mod banner;
pub mod debuglog;
pub mod demux;
pub mod glyph;
pub mod icon;
pub mod local;
pub mod profiles;
pub mod session;
pub mod ssh;
pub mod statelog;
pub mod tileset;
pub mod tilesrc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            use tauri::Manager;
            app.manage(app::AppState::new()?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app::log_frontend_error,
            app::list_profiles,
            app::last_used_profile,
            app::save_profile,
            app::delete_profile,
            app::has_saved_password,
            app::list_tilesets,
            app::get_tileset,
            app::add_custom_tileset,
            app::session_connect,
            app::session_write,
            app::session_write_bytes,
            app::session_resize,
            app::session_disconnect,
            app::state_log_write,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
