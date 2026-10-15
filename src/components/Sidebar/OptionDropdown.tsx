import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

interface DropdownOption<Value extends string> {
  value: Value;
  label: string;
  disabled?: boolean;
  title?: string;
}

export function OptionDropdown<Value extends string>({ id: providedId, label, descriptionId, value, onChange, options, disabled = false, className = '' }: {
  id?: string;
  label: string;
  descriptionId?: string;
  value: Value;
  onChange: (value: Value) => void;
  options: readonly DropdownOption<Value>[];
  disabled?: boolean;
  className?: string;
}) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const initialFocus = useRef<'first' | 'last' | null>(null);
  const expanded = open && !disabled;

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (!expanded) return;
    const close = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    const items = Array.from(wrap.current!.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)'));
    const selected = items.find(item => item.getAttribute('aria-selected') === 'true');
    const focused = initialFocus.current === 'last' ? items.at(-1)
      : initialFocus.current === 'first' ? items[0] : selected ?? items[0];
    initialFocus.current = null;
    focused?.focus();
    return () => document.removeEventListener('pointerdown', close);
  }, [expanded]);

  const closeAndFocus = () => {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };

  return <div className={`perspective-dropdown-wrap option-dropdown ${className}`.trim()} ref={wrap}
    onBlur={event => {
      // WebKit can blur the focused option without focusing a clicked button.
      // Keep the list mounted until its click completes; outside pointers and Tab close it.
      if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}
    onKeyDown={event => {
      if (disabled) return;
      if (!expanded && event.target === trigger.current && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        initialFocus.current = event.key === 'ArrowUp' ? 'last' : 'first';
        setOpen(true);
        return;
      }
      if (!expanded) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeAndFocus();
      } else if (event.key === 'Tab') {
        closeAndFocus();
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const items = Array.from(wrap.current!.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)'));
        if (!items.length) return;
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    }}>
    <button id={id} ref={trigger} type="button" className="perspective-dropdown-btn" aria-label={label}
      aria-describedby={descriptionId} aria-haspopup="listbox" aria-expanded={expanded}
      aria-controls={expanded ? `${id}-listbox` : undefined} disabled={disabled} onClick={() => setOpen(current => !current)}>
      <span className="perspective-dropdown-value">{options.find(option => option.value === value)?.label}</span>
      <span className="perspective-dropdown-arrow" aria-hidden="true">{expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</span>
    </button>
    {expanded && <div id={`${id}-listbox`} className="perspective-dropdown-list" role="listbox" aria-label={label}>
      {options.map(option => <button key={option.value} type="button" role="option" aria-selected={value === option.value}
        disabled={option.disabled} title={option.title} className={`perspective-dropdown-item${value === option.value ? ' active' : ''}`}
        onClick={() => {
          if (option.disabled) return;
          onChange(option.value);
          closeAndFocus();
        }}>{option.label}</button>)}
    </div>}
  </div>;
}
