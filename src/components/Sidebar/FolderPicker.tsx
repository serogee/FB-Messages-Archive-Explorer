interface FolderPickerProps {
  onOpenFolder: () => Promise<void>;
}

export function FolderPicker({ onOpenFolder }: FolderPickerProps) {
  return (
    <div className="folder-picker">
      <p>
        Select your Facebook archive's <strong>messages</strong> folder to get started.<br />
        No data leaves your device.
      </p>
      <button className="btn btn-primary" id="openFolderBtn" onClick={onOpenFolder}>
        Select messages folder
      </button>
      <p style={{ fontSize: '12px' }}>
        e.g. <code>your_facebook_activity/messages</code>
      </p>
    </div>
  );
}
