/**
 * An on/off switch.
 *
 * A `button` with `role="switch"` rather than a styled checkbox: it carries its
 * own state to assistive technology, and Space/Enter already activate it, so
 * there is no keyboard handling to get wrong. The visible track and knob are
 * drawn with CSS from `aria-checked`, which keeps what is on screen and what is
 * announced from ever disagreeing.
 */
interface Props {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Labels the switch for screen readers; the visible text sits beside it. */
  label: string;
}

export default function Toggle({ checked, onChange, disabled = false, label }: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="toggle"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-knob" />
    </button>
  );
}
