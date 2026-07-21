/**
 * Recording and formatting of global-hotkey accelerators.
 *
 * The accelerator strings here are consumed by Rust's `global-hotkey` parser, and
 * that parser happens to accept `KeyboardEvent.code` values verbatim - `KeyA`,
 * `Digit2`, `BracketLeft`, `ArrowUp`. So we pass `event.code` straight through
 * rather than inventing a mapping that could drift out of sync.
 *
 * The whitelists below mirror what that parser actually supports (verified against
 * global-hotkey 0.8's `parse_key`), so the UI can reject a key before the round
 * trip rather than surfacing a confusing error from the backend.
 */

const IS_MAC = navigator.userAgent.includes("Mac");

/** Held on their own these are not a shortcut yet, just modifiers in progress. */
const MODIFIER_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "CapsLock",
]);

const NAMED_CODES = new Set([
  "Space",
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Comma",
  "Period",
  "Slash",
  "Semicolon",
  "Quote",
  "BracketLeft",
  "BracketRight",
  "Backslash",
  "Backquote",
  "Minus",
  "Equal",
  "PrintScreen",
  "ScrollLock",
  "Pause",
  "NumLock",
  "NumpadAdd",
  "NumpadDecimal",
  "NumpadDivide",
  "NumpadEnter",
  "NumpadEqual",
  "NumpadMultiply",
  "NumpadSubtract",
]);

/** F1-F24, matching the Rust parser's range. F13+ make excellent hotkeys
 *  precisely because almost nothing else claims them. */
const FUNCTION_KEY = /^F(?:[1-9]|1[0-9]|2[0-4])$/;

function isSupportedCode(code: string): boolean {
  return (
    /^Key[A-Z]$/.test(code) ||
    /^Digit[0-9]$/.test(code) ||
    /^Numpad[0-9]$/.test(code) ||
    FUNCTION_KEY.test(code) ||
    NAMED_CODES.has(code)
  );
}

/** Keys dedicated enough to be bound on their own. */
function standsAlone(code: string): boolean {
  return FUNCTION_KEY.test(code) || code === "PrintScreen" || code === "Pause";
}

/**
 * Modifier tokens for the currently held keys.
 *
 * `CommandOrControl` maps to Command on macOS and Control elsewhere, so a config
 * recorded on one platform still makes sense on the other.
 */
function modifierTokens(event: {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): string[] {
  const tokens: string[] = [];
  if (IS_MAC) {
    if (event.metaKey) tokens.push("CommandOrControl");
    if (event.ctrlKey) tokens.push("Control");
  } else {
    if (event.ctrlKey) tokens.push("CommandOrControl");
    if (event.metaKey) tokens.push("Super");
  }
  if (event.altKey) tokens.push("Alt");
  if (event.shiftKey) tokens.push("Shift");
  return tokens;
}

/**
 * Longest combination accepted, counting modifiers and the main key together.
 *
 * Ctrl+Shift+A is three. Anything longer is awkward to hold and easy to trigger
 * by accident while reaching for something else.
 */
export const MAX_KEYS = 3;

export type RecordResult =
  /** Only modifiers held so far - nothing to commit yet. */
  | { kind: "pending"; preview: string }
  | { kind: "invalid"; message: string; preview: string }
  | { kind: "accelerator"; accelerator: string; preview: string };

/**
 * Build an accelerator from the modifiers held in `event` plus an explicit
 * main key.
 *
 * The main key is passed in rather than read from `event.code` so the caller can
 * keep re-deriving the combination as more keys go down. Someone reaching for
 * Ctrl+Shift+A does not necessarily press the modifiers first, and the recorder
 * must not lock in "Ctrl+A" the moment A arrives.
 */
export function buildAccelerator(
  event: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  code: string | null,
): RecordResult {
  const tokens = modifierTokens(event);
  const preview = formatAccelerator([...tokens, ...(code ? [code] : [])].join("+"));

  if (!code) {
    return { kind: "pending", preview: preview ? `${preview} ...` : "" };
  }

  if (!isSupportedCode(code)) {
    return { kind: "invalid", message: `${code} can't be used in a shortcut`, preview };
  }

  if (tokens.length === 0 && !standsAlone(code)) {
    return { kind: "invalid", message: "Add a modifier such as Ctrl, Alt or Shift", preview };
  }

  if (tokens.length + 1 > MAX_KEYS) {
    return {
      kind: "invalid",
      message: `Use at most ${MAX_KEYS} keys - let one go`,
      preview,
    };
  }

  return { kind: "accelerator", accelerator: [...tokens, code].join("+"), preview };
}

/** True when a key press is only a modifier, not the main key of a combination. */
export function isModifierCode(code: string): boolean {
  return MODIFIER_CODES.has(code);
}

const MODIFIER_LABELS: Record<string, string> = IS_MAC
  ? {
      CommandOrControl: "⌘",
      Command: "⌘",
      Super: "⌘",
      Control: "⌃",
      Alt: "⌥",
      Shift: "⇧",
    }
  : {
      CommandOrControl: "Ctrl",
      Command: "Win",
      Super: "Win",
      Control: "Ctrl",
      Alt: "Alt",
      Shift: "Shift",
    };

const KEY_LABELS: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  PrintScreen: "PrtSc",
  PageUp: "PgUp",
  PageDown: "PgDn",
  ScrollLock: "ScrLk",
  NumLock: "NumLk",
  // Short forms so a full combination still fits the fixed-width chip in the
  // settings dialog rather than being ellipsised.
  Backspace: IS_MAC ? "⌫" : "Bksp",
  Delete: IS_MAC ? "⌦" : "Del",
  Enter: "⏎",
  Tab: "⇥",
  NumpadAdd: "Num +",
  NumpadSubtract: "Num −",
  NumpadMultiply: "Num ×",
  NumpadDivide: "Num ÷",
  NumpadDecimal: "Num .",
  NumpadEqual: "Num =",
  NumpadEnter: "Num ⏎",
};

function labelForToken(token: string): string {
  if (MODIFIER_LABELS[token]) return MODIFIER_LABELS[token];
  if (KEY_LABELS[token]) return KEY_LABELS[token];
  if (/^Key[A-Z]$/.test(token)) return token.slice(3);
  if (/^Digit[0-9]$/.test(token)) return token.slice(5);
  if (/^Numpad[0-9]$/.test(token)) return `Num ${token.slice(6)}`;
  return token;
}

/** Human-readable form, e.g. `⌘ ⇧ 2` on macOS or `Ctrl + Shift + 2` elsewhere. */
export function formatAccelerator(accelerator: string): string {
  const labels = accelerator.split("+").map((token) => labelForToken(token.trim()));
  return labels.join(IS_MAC ? " " : " + ");
}

