import { useId } from 'react';
import { isFileSystemAccessSupported } from '../../services/fileSystem';
import type { FolderAccessMode } from '../../types/fileSystem';
import { OptionDropdown } from './OptionDropdown';

export function FolderAccessOptions({ mode, onChange, showDescription = true }: {
  mode: FolderAccessMode;
  onChange: (mode: FolderAccessMode) => void;
  showDescription?: boolean;
}) {
  const id = useId();
  const nativeSupported = isFileSystemAccessSupported();
  const selectedMode = nativeSupported && mode !== 'upload' ? 'native' : 'upload';

  return <div className="folder-access-options">
    <label htmlFor={id}>Folder access</label>
    <OptionDropdown<FolderAccessMode> id={id} label="Folder access" descriptionId={showDescription ? `${id}-description` : undefined}
      value={selectedMode} onChange={onChange} options={[
        { value: 'native', label: 'Native access', disabled: !nativeSupported },
        { value: 'upload', label: 'Read-only access' },
      ]} />
    {showDescription && <p id={`${id}-description`}>
      {selectedMode === 'native'
        ? 'More reliable and supports managing chats. If opening fails, try Read-only access.'
        : 'Browse your archive in read only mode. Loading is slower and may temporarily freeze your browser, especially with large archives.'}
      {!nativeSupported && ' Native access is unavailable in this browser.'}
    </p>}
  </div>;
}
