import { useState, useId, type ReactNode } from 'react';
import { Info, ChevronDown } from 'lucide-react';

export function SettingsSection({ title, children, onInfo, className = '' }: {
    title: string;
    children: ReactNode;
    onInfo?: () => void;
    className?: string;
}) {
    const [open, setOpen] = useState(true);
    const id = useId();
    return (
        <section className={`settings-section ${className}`}>
            <div className="settings-section-heading">
                <button type="button" className="settings-section-toggle" id={`${id}-title`}
                    aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
                    {title}
                </button>
                {onInfo && (
                    <button type="button" className="settings-info-button"
                        aria-label={`Open ${title.toLowerCase()} information`} onClick={event => {
                            event.currentTarget.focus({ preventScroll: true });
                            onInfo();
                        }}>
                        <Info size={16} />
                    </button>
                )}
                <ChevronDown className={`settings-section-chevron${open ? ' open' : ''}`} size={16} aria-hidden="true" />
            </div>
            <div id={id} className="settings-section-content" role="region" aria-labelledby={`${id}-title`} hidden={!open}>
                {children}
            </div>
        </section>
    );
}

export function ToggleRow({
    id,
    label,
    checked,
    onChange,
    disabled,
}: {
    id: string;
    label: string;
    checked: boolean;
    onChange: (val: boolean) => void;
    disabled?: boolean;
}) {
    return (
        <div className="settings-row">
            <label htmlFor={id}>{label}</label>
            <label className="switch">
                <input
                    type="checkbox"
                    id={id}
                    checked={checked}
                    onChange={(e) => onChange(e.target.checked)}
                    disabled={disabled}
                />
                <span className="slider" />
            </label>
        </div>
    );
}
