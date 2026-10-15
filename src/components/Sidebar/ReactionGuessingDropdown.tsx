import type { ReactionGuessingMode } from '../../services/reactions';
import { OptionDropdown } from './OptionDropdown';
const options: { value: ReactionGuessingMode; label: string }[] = [
  { value: 'off', label: "Don't guess" }, { value: 'near', label: 'Guess nearby' }, { value: 'aggressive', label: 'Guess aggressively' },
];
export function ReactionGuessingDropdown({ value, onChange, disabled }: { value: ReactionGuessingMode; onChange: (mode: ReactionGuessingMode) => void; disabled: boolean }) {
  return <OptionDropdown<ReactionGuessingMode> id="reactionTimestampGuessingMode" label="Reaction timestamp matching"
    value={value} onChange={onChange} options={options} disabled={disabled} />;
}
