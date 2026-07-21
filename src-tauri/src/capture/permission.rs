//! Screen-recording permission.
//!
//! macOS does not fail a screenshot when permission is missing - it succeeds and
//! hands back the desktop wallpaper with every window, and even the Finder-drawn
//! desktop icons, silently missing. That is indistinguishable from a working
//! capture of an empty desktop, so the only honest way to tell is to ask the OS
//! directly rather than to guess from the pixels.
//!
//! Permission is granted per binary. A debug build, a release build and the test
//! harness are three different programs as far as macOS is concerned, and each
//! must be granted separately.

/// Sentinel returned to the frontend so it can show the recovery UI rather than
/// a raw error string.
pub const DENIED: &str = "screen-recording-permission-denied";

#[cfg(target_os = "macos")]
mod platform {
    // Both are CoreGraphics, 10.15+.
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    /// Whether this binary may capture the screen. Never prompts.
    pub fn granted() -> bool {
        unsafe { CGPreflightScreenCaptureAccess() }
    }

    /// Ask for access, which shows the system prompt the *first* time only.
    ///
    /// Afterwards macOS returns false immediately without prompting, and the
    /// user has to grant it in System Settings - which is why the UI offers a
    /// link there rather than just asking again.
    pub fn request() -> bool {
        unsafe { CGRequestScreenCaptureAccess() }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    // TODO(windows): Windows has no equivalent gate for desktop capture.
    pub fn granted() -> bool {
        true
    }

    pub fn request() -> bool {
        true
    }
}

pub use platform::{granted, request};

/// Confirm access before capturing, prompting once if we have never asked.
///
/// Returns [`DENIED`] as the error so callers can recognise it without matching
/// on prose.
pub fn ensure() -> Result<(), String> {
    if granted() || request() {
        Ok(())
    } else {
        Err(DENIED.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reports what macOS actually thinks of *this* binary.
    ///
    /// Ignored by default because the answer is a property of the machine, not
    /// of the code. Run it to see why captures are coming back blank:
    /// `cargo test -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn reports_screen_capture_access() {
        // Purely informational: the answer is a property of this machine, not of
        // the code, so there is nothing here to assert.
        println!("screen capture access for this binary: {}", granted());
        println!(
            "permission is per binary - the test harness, the debug build and \
             the release build are three separate grants"
        );
    }
}
