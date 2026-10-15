import { useState, useRef, useEffect, useMemo, useId, type ReactNode } from 'react';
import type { Settings } from '../../hooks/useSettings';
import type { ChatListEntry, MessengerThread } from '../../types/messenger';
import type { ReadableDirectoryHandle } from '../../types/fileSystem';
import { isWritableDirectoryHandle } from '../../types/fileSystem';
import { getParticipantNames } from '../../services/parser';
import { isFileSystemAccessSupported } from '../../services/fileSystem';
import { EnableDeletionModal } from '../Modals/EnableDeletionModal';
import { ShortcutsModal } from '../Modals/ShortcutsModal';
import { FilenamePlaceholdersModal } from '../Modals/FilenamePlaceholdersModal';
import { DisableOfflineModal } from '../Modals/DisableOfflineModal';
import {
    Braces,
    ChevronUp,
    ChevronDown,
    ChevronRight,
    Info,
    Keyboard,
} from 'lucide-react';
import { DEFAULT_ATTACHMENT_FILENAME_TEMPLATE } from '../../services/saveAttachments';
import { disableOfflineSupport } from '../../services/pwa';
import { useReactionContext } from '../../hooks/useReactionFeature';
import { ReactionGuessingDropdown } from './ReactionGuessingDropdown';
import { useThreadData } from '../../hooks/useThreadData';
import { reactionConversationId } from '../../services/reactionAuditInventory';
import { ConsistencyDetailsModal } from '../Modals/ConsistencyDetailsModal';
import { ReactionNoticesInfoModal } from '../Modals/ReactionNoticesInfoModal';
import { FolderAccessOptions } from './FolderAccessOptions';
import { SettingsInfoModal, SettingsInfoRow } from '../Modals/SettingsInfoModal';

const INFO_TITLES = {
    appearance: 'Appearance',
    folder: 'Messages folder',
    management: 'Chat management',
    downloads: 'Downloads',
    offline: 'Offline use',
};

function SettingsSection({ title, children, onInfo, className = '' }: {
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

interface SettingsPanelProps {
    settings: Settings;
    setSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
    chatData?: MessengerThread | null;
    selectedPerspective: string;
    setSelectedPerspective: (name: string) => void;
    onOpenFolder: () => Promise<void>;
    folderLoadingStatus?: ReactNode;
    rootHandle: ReadableDirectoryHandle | null;
    onAttachmentBookmarkingChange: (enabled: boolean) => Promise<boolean>;
    chatEntries: ChatListEntry[];
    onSelectChat: (entry: ChatListEntry) => Promise<void>;
}

function ToggleRow({
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

function PerspectiveDropdown({
    participants,
    selectedPerspective,
    setSelectedPerspective,
}: {
    participants: string[];
    selectedPerspective: string;
    setSelectedPerspective: (name: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const [filter, setFilter] = useState('');
    const wrapRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    const filtered = filter.trim()
        ? participants.filter((p) =>
              p.toLowerCase().includes(filter.toLowerCase()),
          )
        : participants;

    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            if (
                wrapRef.current &&
                !wrapRef.current.contains(e.target as Node)
            ) {
                setOpen(false);
                setFilter('');
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open]);

    const select = (name: string) => {
        setSelectedPerspective(name);
        setOpen(false);
        setFilter('');
    };

    return (
        <div className="perspective-dropdown-wrap" ref={wrapRef}>
            <button
                className="perspective-dropdown-btn"
                onClick={() => {
                    setOpen((v) => !v);
                    setTimeout(() => inputRef.current?.focus(), 30);
                }}
                type="button"
                aria-haspopup="listbox"
                aria-expanded={open}
            >
                <span className="perspective-dropdown-value">
                    {selectedPerspective || 'Select...'}
                </span>
                <span className="perspective-dropdown-arrow">
                    {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </span>
            </button>
            {open && (
                <div className="perspective-dropdown-list" role="listbox">
                    <input
                        ref={inputRef}
                        className="perspective-dropdown-search"
                        type="text"
                        placeholder="Search..."
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Escape') {
                                setOpen(false);
                                setFilter('');
                            }
                            if (e.key === 'Enter' && filtered.length === 1)
                                select(filtered[0]);
                        }}
                    />
                    {filtered.length === 0 && (
                        <div className="perspective-dropdown-empty">
                            No match
                        </div>
                    )}
                    {filtered.map((name) => (
                        <button
                            key={name}
                            className={`perspective-dropdown-item${name === selectedPerspective ? ' active' : ''}`}
                            onClick={() => select(name)}
                            role="option"
                            aria-selected={name === selectedPerspective}
                        >
                            {name}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

export function SettingsPanel({
    settings,
    setSetting,
    chatData: providedThread,
    selectedPerspective,
    setSelectedPerspective,
    onOpenFolder,
    folderLoadingStatus,
    rootHandle,
    onAttachmentBookmarkingChange,
    chatEntries,
    onSelectChat,
}: SettingsPanelProps) {
    const chatData = useThreadData(providedThread);
    const participants = getParticipantNames(chatData);
    const reactionFeature = useReactionContext();
    const fsSupported = isFileSystemAccessSupported();
    const readOnlyFolder = !!rootHandle && !isWritableDirectoryHandle(rootHandle);
    const canManageChats = fsSupported && !readOnlyFolder;
    const [infoSection, setInfoSection] = useState<keyof typeof INFO_TITLES | null>(null);
    const [showEnableModal, setShowEnableModal] = useState(false);
    const [showShortcutsModal, setShowShortcutsModal] = useState(false);
    const [showFilenamePlaceholdersModal, setShowFilenamePlaceholdersModal] =
        useState(false);
    const [bookmarkPermissionError, setBookmarkPermissionError] =
        useState(false);
    const [showDisableOfflineModal, setShowDisableOfflineModal] =
        useState(false);
    const [consistencyDetails, setConsistencyDetails] = useState<
        'inconsistent' | 'unmatched' | null
    >(null);
    const [showReactionNoticesInfo, setShowReactionNoticesInfo] =
        useState(false);
    const [offlineSupportBusy, setOfflineSupportBusy] = useState(false);
    const [offlineSupportError, setOfflineSupportError] = useState<
        string | null
    >(null);
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
    const consistencyPercent = reactionFeature.consistency.notices
        ? `${(((reactionFeature.consistency.candidates || 0) / reactionFeature.consistency.notices) * 100).toFixed(1)}%`
        : null;

    const handleDeletionToggle = (val: boolean) => {
        if (val) {
            // Always require explicit confirmation before enabling
            setShowEnableModal(true);
        } else {
            setSetting('deletionEnabled', false as Settings['deletionEnabled']);
        }
    };

    const handleBookmarkingToggle = async (val: boolean) => {
        setBookmarkPermissionError(false);
        try {
            const changed = await onAttachmentBookmarkingChange(val);
            if (!changed && val) setBookmarkPermissionError(true);
        } catch {
            if (val) setBookmarkPermissionError(true);
        }
    };

    const handleOfflineSupportToggle = (enabled: boolean) => {
        setOfflineSupportError(null);
        if (!enabled) {
            setShowDisableOfflineModal(true);
            return;
        }
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            setOfflineSupportError('Reconnect to enable offline support.');
            return;
        }
        setSetting('offlineSupportEnabled', true);
    };

    const handleDisableOfflineSupport = async () => {
        setOfflineSupportBusy(true);
        setOfflineSupportError(null);
        setSetting('offlineSupportEnabled', false);
        try {
            await disableOfflineSupport();
            setShowDisableOfflineModal(false);
        } catch (error) {
            console.error('Failed to disable offline support:', error);
            setSetting('offlineSupportEnabled', true);
            setOfflineSupportError(
                'Offline support could not be disabled. Try again.',
            );
        } finally {
            setOfflineSupportBusy(false);
        }
    };

    return (
        <div className="sidebar-scroll-region settings-scroll-region">
            <SettingsSection title="Messages folder" className="messages-folder-settings"
                onInfo={() => setInfoSection('folder')}>
                <FolderAccessOptions showDescription={false} mode={settings.folderAccessMode} onChange={mode => setSetting('folderAccessMode', mode)} />
                {readOnlyFolder && <p className="browser-notice">Read-only folder. Use Native access to manage chats.</p>}
                {rootHandle ? (
                    <div className="folder-display-container">
                        <div
                            className="folder-path-display"
                            title={rootHandle.name}
                        >
                            <span className="folder-path-prefix">…/</span>
                            <span className="folder-path-name">
                                {rootHandle.name}
                            </span>
                        </div>
                        <button
                            className="btn btn-secondary"
                            onClick={onOpenFolder}
                            style={{
                                flexShrink: 0,
                                padding: '4px 8px',
                                fontSize: '13px',
                            }}
                        >
                            Change
                        </button>
                    </div>
                ) : (
                    <button
                        className="btn btn-primary folder-select-button"
                        onClick={onOpenFolder}
                        style={{ marginTop: 4 }}
                    >
                        <span className="folder-select-label-long">
                            Select messages folder
                        </span>
                        <span className="folder-select-label-short">
                            Select folder
                        </span>
                    </button>
                )}
                {folderLoadingStatus}
            </SettingsSection>

            <SettingsSection title="Appearance" onInfo={() => setInfoSection('appearance')}>
                <ToggleRow
                    id="darkModeToggle"
                    label="Dark mode"
                    checked={settings.darkMode}
                    onChange={(v) =>
                        setSetting('darkMode', v as Settings['darkMode'])
                    }
                />
                <ToggleRow
                    id="showMyNameToggle"
                    label="Show my name"
                    checked={settings.showMyName}
                    onChange={(v) =>
                        setSetting('showMyName', v as Settings['showMyName'])
                    }
                />
                <ToggleRow
                    id="showTheirNameToggle"
                    label="Show their names"
                    checked={settings.showTheirName}
                    onChange={(v) =>
                        setSetting(
                            'showTheirName',
                            v as Settings['showTheirName'],
                        )
                    }
                />
                <ToggleRow
                    id="showReactionsToggle"
                    label="Show reactions"
                    checked={settings.showReactions}
                    onChange={(v) =>
                        setSetting(
                            'showReactions',
                            v as Settings['showReactions'],
                        )
                    }
                />
                <ToggleRow
                    id="autoCollapseDateNavToggle"
                    label="Open date navigator on hover"
                    checked={settings.autoCollapseDateNav}
                    onChange={(v) =>
                        setSetting(
                            'autoCollapseDateNav',
                            v as Settings['autoCollapseDateNav'],
                        )
                    }
                />

                {chatData && participants.length > 0 && (
                    <div className="settings-subsection">
                        <h3 className="settings-subsection-title">View perspective</h3>
                        <PerspectiveDropdown
                            participants={participants}
                            selectedPerspective={selectedPerspective}
                            setSelectedPerspective={setSelectedPerspective}
                        />
                    </div>
                )}
            </SettingsSection>

            <SettingsSection title="Chat management" onInfo={() => setInfoSection('management')}>
                <ToggleRow
                    id="attachmentBookmarkingEnabledToggle"
                    label="Enable bookmarking"
                    checked={canManageChats && settings.attachmentBookmarkingEnabled}
                    onChange={handleBookmarkingToggle}
                    disabled={!canManageChats}
                />
                <ToggleRow
                    id="deletionEnabledToggle"
                    label="Enable chat deletion"
                    checked={canManageChats && settings.deletionEnabled}
                    onChange={handleDeletionToggle}
                    disabled={!canManageChats}
                />
                {!canManageChats && (
                    <p className="browser-notice">
                        {readOnlyFolder
                            ? 'Open the folder using Native access to save bookmarks and delete chats.'
                            : 'Native folder access is required to save bookmarks and delete chats.'}
                    </p>
                )}
                {canManageChats && bookmarkPermissionError && (
                    <p className="browser-notice" role="alert">
                        Write access is required to enable attachment bookmarking.
                    </p>
                )}
                {canManageChats && settings.deletionEnabled && (
                    <p className="browser-notice">Deleting a chat permanently removes its files from your device.</p>
                )}
                {!rootHandle && canManageChats &&
                    (settings.attachmentBookmarkingEnabled || settings.deletionEnabled) && (
                        <p className="browser-notice">Write access will be requested when you open a folder.</p>
                    )}
            </SettingsSection>

            <SettingsSection title="Reaction notices" onInfo={() => setShowReactionNoticesInfo(true)}>
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
                            <p className="browser-notice">
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
                                        setConsistencyDetails('inconsistent')
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
                                        setConsistencyDetails('unmatched')
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

            <SettingsSection title="Downloads" onInfo={() => setInfoSection('downloads')}>
                <ToggleRow
                    id="dateAttachmentFilenamesToggle"
                    label="Name attachments by message date and time"
                    checked={settings.dateAttachmentFilenames}
                    onChange={(v) =>
                        setSetting(
                            'dateAttachmentFilenames',
                            v as Settings['dateAttachmentFilenames'],
                        )
                    }
                />
                {settings.dateAttachmentFilenames && (
                    <>
                        <label
                            className="filename-template-label"
                            htmlFor="attachmentFilenameTemplate"
                        >
                            Filename template
                        </label>
                        <div className="filename-template-row">
                            <input
                                id="attachmentFilenameTemplate"
                                className="filename-template-input"
                                type="text"
                                maxLength={200}
                                value={settings.attachmentFilenameTemplate}
                                placeholder={
                                    DEFAULT_ATTACHMENT_FILENAME_TEMPLATE
                                }
                                onChange={(event) =>
                                    setSetting(
                                        'attachmentFilenameTemplate',
                                        event.target.value
                                            .replace(/\.?\{ext\}/g, '')
                                            .replace(
                                                /[^\p{L}\p{N}\s{}_-]/gu,
                                                '',
                                            ) as Settings['attachmentFilenameTemplate'],
                                    )
                                }
                                spellCheck={false}
                            />
                            <span className="filename-template-extension">
                                .{'{ext}'}
                            </span>
                            <button
                                type="button"
                                className="btn btn-secondary filename-template-reset"
                                onClick={() =>
                                    setSetting(
                                        'attachmentFilenameTemplate',
                                        DEFAULT_ATTACHMENT_FILENAME_TEMPLATE as Settings['attachmentFilenameTemplate'],
                                    )
                                }
                                disabled={
                                    settings.attachmentFilenameTemplate ===
                                    DEFAULT_ATTACHMENT_FILENAME_TEMPLATE
                                }
                            >
                                Reset
                            </button>
                        </div>
                        <button
                            className="settings-shortcuts-btn filename-placeholders-btn"
                            onClick={() =>
                                setShowFilenamePlaceholdersModal(true)
                            }
                        >
                            <Braces size={17} />
                            <span>Filename placeholders</span>
                            <ChevronRight size={16} />
                        </button>
                        <ToggleRow
                            id="longAttachmentFilenamesToggle"
                            label="Enable long filenames"
                            checked={settings.longAttachmentFilenames}
                            onChange={(v) =>
                                setSetting(
                                    'longAttachmentFilenames',
                                    v as Settings['longAttachmentFilenames'],
                                )
                            }
                        />
                    </>
                )}
            </SettingsSection>

            <SettingsSection title="Offline use" onInfo={() => setInfoSection('offline')}>
                <ToggleRow
                    id="offlineSupportEnabledToggle"
                    label="Keep app available offline"
                    checked={settings.offlineSupportEnabled}
                    onChange={handleOfflineSupportToggle}
                    disabled={offlineSupportBusy}
                />
                {offlineSupportError && (
                    <p className="browser-notice">{offlineSupportError}</p>
                )}
            </SettingsSection>

            <SettingsSection title="Help">
                <button
                    className="settings-shortcuts-btn"
                    onClick={() => setShowShortcutsModal(true)}
                >
                    <Keyboard size={17} />
                    <span>Keyboard shortcuts</span>
                    <ChevronRight size={16} />
                </button>

                <div className="settings-subsection download-info">
                    <h3 className="settings-subsection-title">How to export your messages</h3>
                    <a
                        href="https://www.facebook.com/dyi"
                        target="_blank"
                        rel="noreferrer"
                    >
                        Facebook Download Your Information
                    </a>
                    <a
                        href="https://www.messenger.com/secure_storage/dyi"
                        target="_blank"
                        rel="noreferrer"
                    >
                        Messenger Download Your Information
                    </a>
                    <a
                        href="https://accountscenter.instagram.com/info_and_permissions/dyi/"
                        target="_blank"
                        rel="noreferrer"
                    >
                        Instagram Download Your Information
                    </a>
                    <p className="footer">
                        Select <strong style={{ fontSize: '0.85em' }}>JSON</strong>{' '}
                        format and download the <em>Messages</em> category. Extract
                        the zip and open the export folder or its{' '}
                        <code>messages</code> folder here.
                    </p>
                </div>
            </SettingsSection>

            {showEnableModal && (
                <EnableDeletionModal
                    onConfirm={() => {
                        setSetting(
                            'deletionEnabled',
                            true as Settings['deletionEnabled'],
                        );
                        setShowEnableModal(false);
                    }}
                    onCancel={() => setShowEnableModal(false)}
                />
            )}

            {showDisableOfflineModal && (
                <DisableOfflineModal
                    busy={offlineSupportBusy}
                    onCancel={() => setShowDisableOfflineModal(false)}
                    onDisable={() => void handleDisableOfflineSupport()}
                />
            )}

            {showShortcutsModal && (
                <ShortcutsModal onClose={() => setShowShortcutsModal(false)} />
            )}

            {consistencyDetails && (
                <ConsistencyDetailsModal
                    chats={consistencyChats[consistencyDetails]}
                    title={
                        consistencyDetails === 'inconsistent'
                            ? 'Chats with inconsistent matches'
                            : 'Chats with unmatched notices'
                    }
                    onOpenChat={onSelectChat}
                    onClose={() => setConsistencyDetails(null)}
                />
            )}

            {showReactionNoticesInfo && (
                <ReactionNoticesInfoModal
                    onClose={() => setShowReactionNoticesInfo(false)}
                />
            )}

            {showFilenamePlaceholdersModal && (
                <FilenamePlaceholdersModal
                    onClose={() => setShowFilenamePlaceholdersModal(false)}
                />
            )}

            {infoSection && (
                <SettingsInfoModal title={INFO_TITLES[infoSection]} onClose={() => setInfoSection(null)}>
                    {infoSection === 'appearance' && (
                        <>
                            <SettingsInfoRow label="Dark mode">Use a dark theme throughout the app.</SettingsInfoRow>
                            <SettingsInfoRow label="Show names">Choose whether your name and other participants&apos; names appear in chats.</SettingsInfoRow>
                            <SettingsInfoRow label="Show reactions">Show the reactions attached to messages.</SettingsInfoRow>
                            <SettingsInfoRow label="View perspective">Place messages from the selected participant on the right as &quot;me&quot;.</SettingsInfoRow>
                            <SettingsInfoRow label="Date navigator">On desktop, open the date navigator when you hover over the chat title. Turn this off to open it with a click.</SettingsInfoRow>
                        </>
                    )}
                    {infoSection === 'folder' && (
                        <>
                            <SettingsInfoRow label="Native access">More reliable and supports managing chats. If opening fails, try Read-only access.</SettingsInfoRow>
                            <SettingsInfoRow label="Read-only access">Browse your archive in read only mode. Loading is slower and may temporarily freeze your browser, especially with large archives.</SettingsInfoRow>
                            <SettingsInfoRow label="Change folder">The access method changes when you select the folder again. Choose a method, then select Change to reopen your folder.</SettingsInfoRow>
                        </>
                    )}
                    {infoSection === 'management' && (
                        <>
                            <SettingsInfoRow label="Bookmarking">Save attachment and link bookmarks, plus pinned chats, to <code>fb-mae/bookmarks.json</code> inside the messages folder. Existing bookmarks are kept when this feature is disabled.</SettingsInfoRow>
                            <SettingsInfoRow label="Chat deletion">Add a <em>Delete chat</em> option to each conversation. This permanently removes the chat folder, including all messages, photos, videos, and audio, from your device storage. <strong>Once deleted, the files cannot be recovered.</strong></SettingsInfoRow>
                            <SettingsInfoRow label="Shared attachments">Check attachments shared across chats while deletion is enabled.</SettingsInfoRow>
                            <SettingsInfoRow label="Permission">Both features require Native access and write permission.</SettingsInfoRow>
                        </>
                    )}
                    {infoSection === 'downloads' && (
                        <>
                            <SettingsInfoRow label="Date and time">Name saved attachments using their message date and time.</SettingsInfoRow>
                            <SettingsInfoRow label="Filename template">Include names, dates, or the original filename. Open Filename placeholders to see the available fields. The file extension is always included.</SettingsInfoRow>
                            <SettingsInfoRow label="Long filenames">Allow up to 180 characters instead of 100, including the extension. Names are normalized and stripped of unsupported symbols.</SettingsInfoRow>
                        </>
                    )}
                    {infoSection === 'offline' && (
                        <>
                            <SettingsInfoRow label="Offline use">Store the app files and chat parsers so the app can open offline.</SettingsInfoRow>
                            <SettingsInfoRow label="Archive files">Messages and attachments are not stored in the app cache.</SettingsInfoRow>
                        </>
                    )}
                </SettingsInfoModal>
            )}
        </div>
    );
}
