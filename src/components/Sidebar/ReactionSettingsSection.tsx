import { useMemo } from 'react';
import { ChevronRight, LoaderCircle } from 'lucide-react';
import type { Settings } from '../../hooks/useSettings';
import type { ChatListEntry } from '../../types/messenger';
import { useReactionContext } from '../../hooks/useReactionFeature';
import { reactionConversationId } from '../../services/reactionAuditInventory';
import { ConsistencyDetailsModal } from '../Modals/ConsistencyDetailsModal';
import { ReactionNoticesInfoModal } from '../Modals/ReactionNoticesInfoModal';
import { ReactionGuessingDropdown } from './ReactionGuessingDropdown';
import { SettingsSection, ToggleRow } from './SettingsControls';

type ReactionSettingKey = 'hideLikelyReactionNotices' | 'reactionTimestampGuessingMode';
type ConsistencyDetails = 'inconsistent' | 'unmatched';

interface ReactionSettingsSectionProps {
    settings: Pick<Settings, ReactionSettingKey>;
    setSetting: <K extends ReactionSettingKey>(key: K, value: Settings[K]) => void;
    onInfo: () => void;
    onShowDetails: (details: ConsistencyDetails) => void;
}

export function ReactionSettingsSection({ settings, setSetting, onInfo, onShowDetails }: ReactionSettingsSectionProps) {
    const reactionFeature = useReactionContext();
    const consistencyPercent = reactionFeature.consistency.notices
        ? `${(((reactionFeature.consistency.candidates || 0) / reactionFeature.consistency.notices) * 100).toFixed(1)}%`
        : null;

    return (
        <SettingsSection title="Reaction notices" onInfo={onInfo}>
            <ToggleRow
                id="hideLikelyReactionNotices"
                label="Hide reaction notices"
                checked={settings.hideLikelyReactionNotices}
                disabled={!reactionFeature.applicable}
                onChange={(v) => setSetting('hideLikelyReactionNotices', v)}
            />
            <label htmlFor="reactionTimestampGuessingMode">
                Reaction timestamp matching
            </label>
            <ReactionGuessingDropdown
                value={settings.reactionTimestampGuessingMode}
                onChange={(v) =>
                    setSetting('reactionTimestampGuessingMode', v)
                }
                disabled={!reactionFeature.applicable}
            />
            {!reactionFeature.applicable ? (
                <p className="browser-notice">
                    Does not apply to this Messenger export.
                </p>
            ) : (
                <>
                    <div className="reaction-guessing-status">
                        <p className="browser-notice" role="status">
                            {settings.reactionTimestampGuessingMode ===
                            'off'
                                ? reactionFeature.hasCache
                                    ? 'Guesses cached'
                                    : 'No guesses cached'
                                : reactionFeature.status === 'ready'
                                  ? 'Guesses Available'
                                  : reactionFeature.reason ||
                                    (reactionFeature.status === 'checking'
                                        ? 'Checking reaction notices…'
                                        : 'Select a Facebook or Instagram export.')}
                        </p>
                        {settings.reactionTimestampGuessingMode ===
                        'off' ? (
                            <button
                                type="button"
                                className="btn btn-secondary reaction-refresh-control"
                                onClick={reactionFeature.clear}
                                disabled={!reactionFeature.canClear}
                            >
                                Clear
                            </button>
                        ) : (
                            [
                                'checking',
                                'failed',
                                'unavailable',
                                'ready',
                            ].includes(reactionFeature.status) && (
                                <button
                                    type="button"
                                    className="btn btn-secondary reaction-refresh-control"
                                    onClick={reactionFeature.retry}
                                >
                                    Refresh
                                </button>
                            )
                        )}
                    </div>
                    <div className="reaction-guessing-status">
                        <p className="browser-notice archive-check-label">
                            {reactionFeature.consistency.status === 'checking' && (
                                <LoaderCircle size={14} className="loading-spinner" aria-hidden="true" />
                            )}
                            Full archive consistency check
                        </p>
                        {reactionFeature.consistency.status ===
                        'checking' ? (
                            <button
                                type="button"
                                className="btn btn-secondary reaction-refresh-control"
                                onClick={reactionFeature.cancelArchiveCheck}
                            >
                                Cancel
                            </button>
                        ) : (
                            <button
                                type="button"
                                className="btn btn-secondary reaction-refresh-control"
                                onClick={reactionFeature.checkArchive}
                                disabled={!reactionFeature.canCheckArchive}
                            >
                                {reactionFeature.consistency.status ===
                                'idle'
                                    ? 'Check archive'
                                    : 'Check again'}
                            </button>
                        )}
                    </div>
                    {reactionFeature.consistency.status !== 'idle' && (
                        <p className="browser-notice" role="status">
                            {reactionFeature.consistency.status ===
                            'checking'
                                ? 'Full archive consistency check running. '
                                : consistencyPercent
                                  ? `Full archive consistency check: ${consistencyPercent} passed. `
                                  : 'Full archive consistency check was inconclusive. '}
                            {reactionFeature.consistency.reason}
                        </p>
                    )}
                    {reactionFeature.consistency.status ===
                        'inconsistent' && (
                        <>
                            <button
                                type="button"
                                className="settings-shortcuts-btn"
                                onClick={() =>
                                    onShowDetails('inconsistent')
                                }
                            >
                                <span>View inconsistent matches</span>
                                <ChevronRight size={16} />
                            </button>
                        </>
                    )}
                    {reactionFeature.consistency.status !== 'checking' &&
                        reactionFeature.consistency.unmatchedChats.length >
                            0 && (
                            <button
                                type="button"
                                className="settings-shortcuts-btn"
                                onClick={() =>
                                    onShowDetails('unmatched')
                                }
                            >
                                <span>
                                    View chats with unmatched notices
                                </span>
                                <ChevronRight size={16} />
                            </button>
                        )}
                </>
            )}
        </SettingsSection>
    );
}

interface ReactionSettingsDialogsProps {
    details: ConsistencyDetails | null;
    infoOpen: boolean;
    chatEntries: ChatListEntry[];
    onOpenChat: (entry: ChatListEntry) => Promise<void>;
    onCloseDetails: () => void;
    onCloseInfo: () => void;
}

// Keep dialogs at SettingsPanel's existing modal position, outside collapsed
// section content. The parent retains their independent visibility/lifetime.
export function ReactionSettingsDialogs({ details, infoOpen, chatEntries, onOpenChat, onCloseDetails, onCloseInfo }: ReactionSettingsDialogsProps) {
    const reactionFeature = useReactionContext();
    const consistencyChats = useMemo(() => {
        const entries = new Map(
            chatEntries.map((entry) => [
                reactionConversationId(entry.source, entry.folderName),
                entry,
            ]),
        );
        const resolve = (
            issues: typeof reactionFeature.consistency.inconsistentChats,
        ) =>
            issues.flatMap((issue) => {
                const entry = entries.get(issue.id);
                return entry ? [{ entry, issue }] : [];
            });
        return {
            inconsistent: resolve(
                reactionFeature.consistency.inconsistentChats,
            ),
            unmatched: resolve(reactionFeature.consistency.unmatchedChats),
        };
    }, [
        chatEntries,
        reactionFeature.consistency.inconsistentChats,
        reactionFeature.consistency.unmatchedChats,
    ]);
    return (
        <>
            {details && (
                <ConsistencyDetailsModal
                    chats={consistencyChats[details]}
                    title={
                        details === 'inconsistent'
                            ? 'Chats with inconsistent matches'
                            : 'Chats with unmatched notices'
                    }
                    onOpenChat={onOpenChat}
                    onClose={() => onCloseDetails()}
                />
            )}

            {infoOpen && (
                <ReactionNoticesInfoModal
                    onClose={() => onCloseInfo()}
                />
            )}
        </>
    );
}
