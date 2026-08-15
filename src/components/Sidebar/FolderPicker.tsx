import { isFileSystemAccessSupported } from '../../services/fileSystem';

interface FolderPickerProps {
  onOpenFolder: () => Promise<void>;
}

export function FolderPicker({ onOpenFolder }: FolderPickerProps) {
  const fsSupported = isFileSystemAccessSupported();

  return (
    <div className="folder-picker">
      <p>
        Select your Facebook archive's <strong>messages</strong> folder to get started.<br />
        No data leaves your device.
      </p>
      <button className="btn btn-primary" id="openFolderBtn" onClick={onOpenFolder}>
        Select messages folder
      </button>
      <p style={{ fontSize: '12px', marginBottom: fsSupported ? 0 : 12 }}>
        e.g. <code>your_facebook_activity/messages</code>
      </p>
      
      {!fsSupported && (
        <div className="browser-warning" style={{ fontSize: '12px', color: '#ffb86c', marginTop: '12px', padding: '8px', background: 'rgba(255, 184, 108, 0.1)', borderRadius: '4px', border: '1px solid rgba(255, 184, 108, 0.2)' }}>
          <strong>Note:</strong> You are using a browser that doesn't support the native File System API (like Firefox or Safari). 
          <br /><br />
          Selecting a massive folder may freeze your browser for a few seconds while it scans every file. For the best and fastest experience, use Google Chrome or Microsoft Edge.
        </div>
      )}
    </div>
  );
}
