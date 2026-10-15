import { useEffect, useState } from 'react';
import type { ReadableDirectoryHandle } from '../../types/fileSystem';
import type { MediaState, MessengerThread } from '../../types/messenger';
import { checkMessengerAttachmentFiles } from '../../services/messengerExport/messengerExportDiagnostics';
import { LoadingLabel } from '../LoadingLabel';

export function AttachmentFileDetails({ root, thread, mediaState }: {
  root: ReadableDirectoryHandle;
  thread: MessengerThread;
  mediaState: MediaState;
}) {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  useEffect(() => {
    setReport(null);
    if (!open) return;
    const controller = new AbortController();
    void checkMessengerAttachmentFiles(root, thread, mediaState, controller.signal).then(
      details => { if (!controller.signal.aborted) setReport(details); },
      () => { if (!controller.signal.aborted) setReport('The selected folder could not be checked.'); },
    );
    return () => controller.abort();
  }, [open, root, thread, mediaState]);

  return (
    <details className="attachment-file-details" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>Attachment file details</summary>
      <p>Counts come from the messages. These checks inspect the files in the selected folder.</p>
      {open && (report ? <pre>{report}</pre> : <div role="status"><LoadingLabel label="Checking attachment files" /></div>)}
    </details>
  );
}
