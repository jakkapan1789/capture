import { useEffect, useMemo, useState } from "react";

import Select from "../components/Select";
import { TrashIcon } from "../lib/icons";
import type { CaptureMeta } from "../lib/ipc";

/** Preset cut-offs, plus the two open-ended cases. */
type Filter = "7d" | "30d" | "90d" | "before" | "all";

const PRESETS: { value: Filter; label: string }[] = [
  { value: "7d", label: "Older than 7 days" },
  { value: "30d", label: "Older than 30 days" },
  { value: "90d", label: "Older than 90 days" },
  { value: "before", label: "Taken before a date" },
  { value: "all", label: "Everything" },
];

const DAY = 24 * 60 * 60 * 1000;

/** Local midnight for a `yyyy-mm-dd` string, or null if it isn't a real date. */
function startOfLocalDay(value: string): number | null {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function todayValue(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Captures the current filter would remove. */
export function matchingCaptures(
  items: CaptureMeta[],
  filter: Filter,
  before: string,
): CaptureMeta[] {
  if (filter === "all") return items;

  const cutoff =
    filter === "before" ? startOfLocalDay(before) : Date.now() - Number(filter.slice(0, -1)) * DAY;

  if (cutoff === null) return [];
  return items.filter((item) => item.createdAt < cutoff);
}

interface Props {
  items: CaptureMeta[];
  onDelete: (ids: string[]) => Promise<void>;
  onClose: () => void;
}

export default function DeleteCapturesDialog({ items, onDelete, onClose }: Props) {
  const [filter, setFilter] = useState<Filter>("30d");
  const [before, setBefore] = useState(todayValue);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, busy]);

  const matches = useMemo(
    () => matchingCaptures(items, filter, before),
    [items, filter, before],
  );

  const summary =
    matches.length === 0
      ? "Nothing matches - no captures will be deleted."
      : matches.length === items.length
        ? `All ${items.length} captures will be deleted.`
        : `${matches.length} of ${items.length} captures will be deleted.`;

  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-label="Delete captures">
        <header className="modal-header">
          <h2>Delete captures</h2>
          <button type="button" className="modal-close" onClick={onClose} title="Close">
            &times;
          </button>
        </header>

        <section className="setting">
          <div className="setting-text">
            <strong>Which captures</strong>
            <span>Deleting removes the image and its annotations.</span>
          </div>

          <Select
            className="field-select"
            value={filter}
            options={PRESETS.map((preset) => ({ value: preset.value, label: preset.label }))}
            onChange={setFilter}
            label="Which captures to delete"
          />
        </section>

        {filter === "before" && (
          <section className="setting setting-secondary">
            <div className="setting-text">
              <strong>Before</strong>
              <span>Captures taken on this day are kept.</span>
            </div>
            <input
              type="date"
              className="field-input"
              value={before}
              max={todayValue()}
              onChange={(event) => setBefore(event.target.value)}
              aria-label="Cut-off date"
            />
          </section>
        )}

        {/* Fixed-height slot so the dialog does not resize as the count changes. */}
        <div className="setting-message">
          <p className={matches.length > 0 ? "setting-warning" : "setting-hint"}>{summary}</p>
        </div>

        <footer className="modal-footer">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn danger"
            disabled={busy || matches.length === 0}
            onClick={async () => {
              setBusy(true);
              try {
                await onDelete(matches.map((item) => item.id));
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            <TrashIcon />
            <span>{busy ? "Deleting..." : `Delete ${matches.length}`}</span>
          </button>
        </footer>
      </div>
    </div>
  );
}
