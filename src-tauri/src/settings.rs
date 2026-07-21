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
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            capture_region_hotkey: Some(DEFAULT_HOTKEY.to_string()),
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

        save(&path, &Settings { capture_region_hotkey: None }).unwrap();
        assert_eq!(load(&path).capture_region_hotkey, None);

        save(
            &path,
            &Settings {
                capture_region_hotkey: Some("Alt+Shift+KeyC".into()),
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
}
