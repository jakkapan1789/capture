import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";

import { CropIcon } from "../lib/icons";
import { appInfo, type AppInfo } from "../lib/ipc";

const AUTHOR = "Jakkapan Pakeerat";
const SUPPORT_EMAIL = "support@siconsoft.com";
const TAGLINE = "Screen capture with annotations you can always re-edit.";
const COPYRIGHT_YEAR = new Date().getFullYear();

/**
 * Third-party notices.
 *
 * `xcap` is Apache-2.0 with no permissive alternative, and Apache-2.0 section 4
 * requires attribution to travel with the distributed work. Listing these is a
 * licence obligation once the app ships, not a courtesy.
 */
const NOTICES: { name: string; version: string; licence: string }[] = [
  { name: "Tauri", version: "2", licence: "Apache-2.0 OR MIT" },
  { name: "xcap", version: "0.9.7", licence: "Apache-2.0" },
  { name: "image", version: "0.25", licence: "MIT OR Apache-2.0" },
  { name: "global-hotkey", version: "0.8", licence: "Apache-2.0 OR MIT" },
  { name: "React", version: "19", licence: "MIT" },
  { name: "Konva / react-konva", version: "10", licence: "MIT" },
];

const OS_NAMES: Record<string, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
};

interface Props {
  onClose: () => void;
}

export default function AboutDialog({ onClose }: Props) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [notices, setNotices] = useState(false);

  useEffect(() => {
    void appInfo().then(setInfo).catch(() => setInfo(null));
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const platform = info
    ? `${OS_NAMES[info.os] ?? info.os} ${info.arch} · Tauri ${info.tauriVersion}`
    : "";

  return (
    <div className="modal-backdrop">
      <div className="modal about" role="dialog" aria-modal="true" aria-label="About Capture">
        <button type="button" className="modal-close about-close" onClick={onClose} title="Close">
          &times;
        </button>

        <header className="about-header">
          <div className="about-mark" aria-hidden="true">
            <CropIcon size={30} />
          </div>
          <div className="about-identity">
            <h2>{info?.name ?? "Capture"}</h2>
            <p className="about-version">Version {info?.version ?? "..."}</p>
            <p className="about-tagline">{TAGLINE}</p>
          </div>
        </header>

        <dl className="about-facts">
          <div>
            <dt>Made by</dt>
            <dd>{AUTHOR}</dd>
          </div>
          <div>
            <dt>Licence</dt>
            <dd>MIT — free to use, modify and share</dd>
          </div>
          <div>
            <dt>Support</dt>
            <dd>
              <button
                type="button"
                className="link-btn"
                onClick={() => void openUrl(`mailto:${SUPPORT_EMAIL}`)}
                title="Write to support"
              >
                {SUPPORT_EMAIL}
              </button>
            </dd>
          </div>
          <div>
            <dt>Platform</dt>
            <dd>{platform || "..."}</dd>
          </div>
          <div>
            <dt>Storage</dt>
            <dd className="about-path">
              <span title={info?.storageDir}>{info?.storageDir ?? "..."}</span>
              <button
                type="button"
                className="link-btn"
                disabled={!info}
                onClick={() => info && void revealItemInDir(info.storageDir)}
              >
                Show
              </button>
            </dd>
          </div>
        </dl>

        <div className="about-notices">
          <button
            type="button"
            className="link-btn disclosure"
            onClick={() => setNotices((shown) => !shown)}
            aria-expanded={notices}
          >
            <span className={notices ? "disclosure-caret open" : "disclosure-caret"}>›</span>
            Third-party licences
          </button>

          {notices && (
            <ul>
              {NOTICES.map((notice) => (
                <li key={notice.name}>
                  <span>
                    {notice.name} <em>{notice.version}</em>
                  </span>
                  <span className="about-licence">{notice.licence}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="modal-footer about-footer">
          <span className="about-copyright">
            © {COPYRIGHT_YEAR} {AUTHOR}
          </span>
        </footer>
      </div>
    </div>
  );
}
