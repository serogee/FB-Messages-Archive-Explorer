export function isConversationJsonContent(content: string): boolean {
  try {
    const data = JSON.parse(content);
    return (
      data &&
      typeof data === 'object' &&
      typeof data.threadName === 'string' &&
      Array.isArray(data.participants) &&
      data.participants.some((participant: unknown) => typeof participant === 'string') &&
      Array.isArray(data.messages)
    );
  } catch {
    return false;
  }
}

export async function isMessengerExport(handle: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    await handle.getDirectoryHandle('inbox');
    return false;
  } catch { /* not a Facebook messages root */ }

  try {
    await handle.getDirectoryHandle('archived_threads');
    return false;
  } catch { /* not a Facebook messages root */ }

  let checked = 0;
  for await (const [name, entry] of handle.entries()) {
    if (entry.kind !== 'file' || !/\.json$/i.test(name)) continue;
    if (checked >= 3) break;
    checked++;

    try {
      const file = await (entry as FileSystemFileHandle).getFile();
      if (isConversationJsonContent(await file.text())) return true;
    } catch {
      continue;
    }
  }

  return false;
}
