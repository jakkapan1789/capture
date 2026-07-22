mod capture;
mod commands;
mod hotkey;
mod settings;
mod storage;

use std::sync::Mutex;

use tauri::{Emitter, Manager};

/// Menu item id and the event it raises, kept together so they cannot drift.
#[cfg(target_os = "macos")]
const MENU_ABOUT: &str = "about";
const MENU_ABOUT_EVENT: &str = "menu://about";

use commands::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // See `install_menu`: the stock menu claims the very shortcuts this app
        // needs to receive itself.
        .enable_macos_default_menu(false)
        .manage(AppState {
            capture: capture::create_capture(),
            settings: Mutex::new(settings::Settings::default()),
            pending_frame: Mutex::new(None),
        })
        .setup(|app| {
            let handle = app.handle().clone();
            install_menu(app)?;

            let stored = settings::load(&commands::settings_path(&handle)?);

            // A hotkey another app already owns must not stop startup. The setting
            // is kept either way so the UI can show it as unregistered and let the
            // user pick a different one.
            if let Err(error) = hotkey::apply(&handle, stored.capture_region_hotkey.as_deref()) {
                eprintln!("could not register the saved hotkey: {error}");
            }

            *app.state::<AppState>()
                .settings
                .lock()
                .expect("settings mutex poisoned during setup") = stored;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_monitors,
            commands::open_region_overlay,
            commands::close_region_overlay,
            commands::capture_region,
            commands::capture_monitor,
            commands::read_capture_image,
            commands::read_capture_thumbnail,
            commands::save_annotations,
            commands::save_capture_piece,
            commands::read_capture_piece,
            commands::list_gallery,
            commands::load_gallery_item,
            commands::delete_gallery_item,
            commands::delete_gallery_items,
            commands::capture_file_path,
            commands::screen_permission_granted,
            commands::app_info,
            commands::get_settings,
            commands::set_capture_hotkey,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Replace macOS's stock application menu with a minimal one.
///
/// Tauri installs a default menu whose Edit submenu owns Undo, Redo, Cut, Copy,
/// Paste and Select All. On macOS the menu bar consumes those key combinations
/// *before* the webview ever sees them, which quietly breaks two things:
///
/// * the editor's own Cmd+Z / Cmd+C / Cmd+V / Cmd+A handlers, and
/// * the hotkey recorder, which appears to "only accept two keys" because the
///   third key press is swallowed on its way in.
///
/// Dropping the Edit submenu hands those back to the app. App and Window keep
/// their standard items, so Cmd+Q, Cmd+W, Cmd+M and Cmd+H still behave the way
/// every Mac user expects - and those are combinations nobody wants to rebind.
fn install_menu(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "macos")]
    {
        use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};

        let handle = app.handle();

        let app_menu = Submenu::with_items(
            handle,
            "Capture",
            true,
            &[
                // A custom item rather than the predefined one: the predefined
                // About opens a native panel, which would mean two different
                // About screens saying different things.
                &MenuItem::with_id(handle, MENU_ABOUT, "About Capture", true, None::<&str>)?,
                &PredefinedMenuItem::separator(handle)?,
                &PredefinedMenuItem::hide(handle, None)?,
                &PredefinedMenuItem::hide_others(handle, None)?,
                &PredefinedMenuItem::show_all(handle, None)?,
                &PredefinedMenuItem::separator(handle)?,
                &PredefinedMenuItem::quit(handle, None)?,
            ],
        )?;

        let window_menu = Submenu::with_items(
            handle,
            "Window",
            true,
            &[
                &PredefinedMenuItem::minimize(handle, None)?,
                &PredefinedMenuItem::close_window(handle, None)?,
            ],
        )?;

        app.set_menu(Menu::with_items(handle, &[&app_menu, &window_menu])?)?;
        app.on_menu_event(|app, event| {
            if event.id() == MENU_ABOUT {
                let _ = app.emit_to(commands::MAIN_LABEL, MENU_ABOUT_EVENT, ());
            }
        });
    }

    // Other platforms get no menu bar at all; the app is a single toolbar.
    #[cfg(not(target_os = "macos"))]
    let _ = app;

    Ok(())
}
