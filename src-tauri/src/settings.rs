//! Persisted user settings.
//!
//! Stored as `<app-data>/settings.json`, separate from the gallery so clearing
//! history never touches preferences.

use std::fs;
use std::path::Path;

use anyhow::Result;
use serde::{Deserialize, Serialize};

/// Default region-capture hotkey.
///
/// Deliberately not Cmd+Shift+3/4/5 - those are taken by macOS's own screenshot
/// tools and registration would just fail.
pub const DEFAULT_HOTKEY: &str = "CommandOrControl+Shift+2";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Accelerator for region capture, or `None` when the hotkey is switched off.
    pub capture_region_hotkey: Option<String>,
    /// Copy every new capture to the clipboard as soon as it is taken.
    ///
    /// Off by default: the clipboard is shared with everything else the user is
    /// doing, and silently replacing what is in it is not a thing to opt someone
    /// into.
    pub auto_copy_to_clipboard: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            capture_region_hotkey: Some(DEFAULT_HOTKEY.to_string()),
            auto_copy_to_clipboard: false,
        }
    }
}

/// A partial update. Every field is optional, so the frontend can change one
/// preference without having to send - and risk clobbering - the others.
///
/// The hotkey is deliberately not here: setting it can fail, and it has to be
/// rolled back when it does, which is a different shape of operation.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PreferencesPatch {
    pub auto_copy_to_clipboard: Option<bool>,
}

impl Settings {
    pub fn apply(&mut self, patch: PreferencesPatch) {
        if let Some(value) = patch.auto_copy_to_clipboard {
            self.auto_copy_to_clipboard = value;
        }
    }
}

/// Read settings, falling back to defaults.
///
/// A missing or corrupt settings file must never stop the app from starting -
/// the worst case is that preferences reset, which the user can see and fix.
pub fn load(path: &Path) -> Settings {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub fn save(path: &Path, settings: &Settings) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_vec_pretty(settings)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn falls_back_to_defaults_when_the_file_is_unreadable() {
        let missing = Path::new("/nonexistent/settings.json");
        assert_eq!(
            load(missing).capture_region_hotkey.as_deref(),
            Some(DEFAULT_HOTKEY)
        );
    }

    #[test]
    fn round_trips_and_tolerates_a_disabled_hotkey() {
        let dir = std::env::temp_dir().join(format!("capture-settings-{}", std::process::id()));
        let path = dir.join("settings.json");

        save(&path, &Settings { capture_region_hotkey: None, ..Settings::default() }).unwrap();
        assert_eq!(load(&path).capture_region_hotkey, None);

        save(
            &path,
            &Settings {
                capture_region_hotkey: Some("Alt+Shift+KeyC".into()),
                ..Settings::default()
            },
        )
        .unwrap();
        assert_eq!(
            load(&path).capture_region_hotkey.as_deref(),
            Some("Alt+Shift+KeyC")
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn garbage_json_does_not_panic() {
        let dir = std::env::temp_dir().join(format!("capture-bad-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        fs::write(&path, b"{ not json at all").unwrap();

        assert_eq!(
            load(&path).capture_region_hotkey.as_deref(),
            Some(DEFAULT_HOTKEY)
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_patch_only_changes_the_field_it_names() {
        let mut settings = Settings {
            capture_region_hotkey: Some("Alt+KeyQ".into()),
            auto_copy_to_clipboard: false,
        };

        settings.apply(PreferencesPatch {
            auto_copy_to_clipboard: Some(true),
        });
        assert!(settings.auto_copy_to_clipboard);
        assert_eq!(
            settings.capture_region_hotkey.as_deref(),
            Some("Alt+KeyQ"),
            "the hotkey must survive an unrelated preference change"
        );

        settings.apply(PreferencesPatch::default());
        assert!(settings.auto_copy_to_clipboard, "an empty patch changes nothing");
    }

    /// Settings files written before a preference existed must still load, with
    /// the new field taking its default rather than failing the whole parse.
    #[test]
    fn loads_a_settings_file_that_predates_a_preference() {
        let dir = std::env::temp_dir().join(format!("capture-old-settings-{}", std::process::id()));
        let path = dir.join("settings.json");
        fs::create_dir_all(&dir).unwrap();
        fs::write(&path, br#"{"captureRegionHotkey":"Alt+KeyQ"}"#).unwrap();

        let settings = load(&path);
        assert_eq!(settings.capture_region_hotkey.as_deref(), Some("Alt+KeyQ"));
        assert!(!settings.auto_copy_to_clipboard);

        let _ = fs::remove_dir_all(&dir);
    }
}
