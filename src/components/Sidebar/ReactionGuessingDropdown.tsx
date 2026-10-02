import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { ReactionGuessingMode } from '../../services/reactions';
const options: { value: ReactionGuessingMode; label: string }[] = [
  { value: 'off', label: "Don't guess" }, { value: 'near', label: 'Guess nearby' }, { value: 'aggressive', label: 'Guess aggressively' },
];
export function ReactionGuessingDropdown({ value, onChange, disabled }: { value: ReactionGuessingMode; onChange: (mode: ReactionGuessingMode) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!wrap.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    const selected = wrap.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]');
    selected?.focus();
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const choose = (mode: ReactionGuessingMode) => { onChange(mode); setOpen(false); trigger.current?.focus(); };
  return <div className="perspective-dropdown-wrap" ref={wrap} onKeyDown={event => {
    if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); }
    if (open && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const items = Array.from(wrap.current!.querySelectorAll<HTMLButtonElement>('[role="option"]'));
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }
  }}>
    <button id="reactionTimestampGuessingMode" ref={trigger} type="button" className="perspective-dropdown-btn" aria-label="Reaction timestamp matching" aria-haspopup="listbox" aria-expanded={open && !disabled} disabled={disabled} onClick={() => setOpen(v => !v)}>
      <span className="perspective-dropdown-value">{options.find(o => o.value === value)?.label}</span>
      <span className="perspective-dropdown-arrow">{open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</span>
    </button>
    {open && !disabled && <div className="perspective-dropdown-list" role="listbox" aria-label="Reaction timestamp matching">
      {options.map(option => <button type="button" role="option" aria-selected={value === option.value} key={option.value} className={`perspective-dropdown-item${value === option.value ? ' active' : ''}`} onClick={() => choose(option.value)}>{option.label}</button>)}
    </div>}
  </div>;
}
