import type { ReactNode } from 'react';
import { isFileSystemAccessSupported } from '../../services/fileSystem';
import type { FolderAccessMode } from '../../types/fileSystem';
import { FolderAccessOptions } from './FolderAccessOptions';

interface FolderPickerProps {
  onOpenFolder: () => Promise<void>;
  accessMode: FolderAccessMode;
  onAccessModeChange: (mode: FolderAccessMode) => void;
  folderLoadingStatus?: ReactNode;
}

export function FolderPicker({ onOpenFolder, accessMode, onAccessModeChange, folderLoadingStatus }: FolderPickerProps) {
  const fsSupported = isFileSystemAccessSupported();

  return (
    <div className="folder-picker">
      <p>
        Select your Facebook, Messenger, or Instagram archive's <strong>messages</strong> folder, to get started.{' '}
        No data leaves your device.
      </p>
      <FolderAccessOptions mode={accessMode} onChange={onAccessModeChange} />
      <button className="btn btn-primary folder-select-button" id="openFolderBtn" onClick={onOpenFolder}>
        <span className="folder-select-label-long">Select messages folder</span>
        <span className="folder-select-label-short">Select folder</span>
      </button>
      <p style={{ fontSize: '12px', marginBottom: fsSupported ? 0 : 12 }}>
        e.g. <code>your_facebook_activity/messages</code>
      </p>
      <div className="folder-loading-slot">{folderLoadingStatus}</div>
      
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
