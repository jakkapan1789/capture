//! Global hotkey registration.

use tauri::{AppHandle, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// Parse an accelerator without registering it, so the UI can validate input.
pub fn parse(accelerator: &str) -> Result<Shortcut, String> {
    accelerator
        .parse::<Shortcut>()
        .map_err(|error| format!("\"{accelerator}\" is not a valid shortcut: {error}"))
}

/// Whether the given accelerator is currently held by us.
pub fn is_registered<R: Runtime>(app: &AppHandle<R>, accelerator: &str) -> bool {
    match parse(accelerator) {
        Ok(shortcut) => app.global_shortcut().is_registered(shortcut),
        Err(_) => false,
    }
}

/// Make `accelerator` the one and only registered hotkey; `None` clears it.
///
/// Returns `Err` when the combination is malformed or already claimed by another
/// application - the caller is expected to put the previous one back.
pub fn apply<R: Runtime>(app: &AppHandle<R>, accelerator: Option<&str>) -> Result<(), String> {
    let manager = app.global_shortcut();

    manager
        .unregister_all()
        .map_err(|error| format!("could not clear the previous hotkey: {error}"))?;

    let Some(accelerator) = accelerator else {
        return Ok(());
    };

    let shortcut = parse(accelerator)?;
    let handle = app.clone();

    manager
        .on_shortcut(shortcut, move |_app, _shortcut, event| {
            // The handler fires for both press and release; without this the
            // overlay would be opened and then immediately opened again.
            if event.state != ShortcutState::Pressed {
                return;
            }

            let app = handle.clone();
            // Creating a window off the main thread is not safe on macOS.
            let dispatched = handle.run_on_main_thread(move || {
                if let Err(error) = crate::commands::show_region_overlay(&app) {
                    eprintln!("hotkey capture failed: {error}");
                }
            });

            if let Err(error) = dispatched {
                eprintln!("could not dispatch hotkey to the main thread: {error}");
            }
        })
        .map_err(|error| {
            format!("could not register \"{accelerator}\" - another app may be using it ({error})")
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Guards the contract between the frontend recorder and this parser.
    ///
    /// `src/lib/hotkey.ts` emits `KeyboardEvent.code` values directly, so every
    /// shape it can produce has to parse here. If this breaks, the hotkey UI will
    /// silently start rejecting valid key presses.
    #[test]
    fn accepts_every_accelerator_shape_the_recorder_emits() {
        for accelerator in [
            "CommandOrControl+Shift+Digit2",
            "Alt+Shift+KeyC",
            "CommandOrControl+Control+Alt+Shift+KeyA",
            "Super+KeyS",
            "CommandOrControl+ArrowUp",
            "CommandOrControl+Numpad5",
            "CommandOrControl+BracketLeft",
            "CommandOrControl+Backquote",
            "Alt+Space",
            "Alt+NumpadAdd",
            "F5",
            // F13-F24 exist on the parser's side and make good hotkeys because
            // almost nothing else claims them; the recorder allows them too.
            "F13",
            "F24",
            "PrintScreen",
        ] {
            assert!(parse(accelerator).is_ok(), "should parse: {accelerator}");
        }
    }

    #[test]
    fn rejects_what_the_recorder_refuses_to_emit() {
        // Modifiers with no key.
        assert!(parse("Shift").is_err());
        assert!(parse("CommandOrControl+Shift").is_err());
        // Past the end of the function-key range, which is where the recorder's
        // whitelist also stops.
        assert!(parse("CommandOrControl+F25").is_err());
        assert!(parse("").is_err());
    }
}
