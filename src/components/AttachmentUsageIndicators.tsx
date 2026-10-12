import { Link, MessageSquare } from 'lucide-react';
import { useAttachmentChatUsage } from '../hooks/useAttachmentReferences';
import type { ResolvedAttachment } from '../types/messenger';

export function AttachmentUsageIndicators({ attachment }: { attachment: ResolvedAttachment }) {
  const { count, complete } = useAttachmentChatUsage(attachment.mediaPath, attachment.category);
  const usageCount = attachment.usageCount ?? 1;
  if (count <= 1 && usageCount <= 1) return null;
  const chatLabel = complete ? `Attachment used in ${count} chats`
    : `Attachment referenced in ${count} indexed chats (ownership unverified)`;
  return (
    <span className="gallery-reuse-indicators">
      {count > 1 && (
        <span className="gallery-reuse-indicator gallery-cross-chat-indicator" title={chatLabel} aria-label={chatLabel}>
          <MessageSquare size={14} /><span>{count.toLocaleString()}</span>
        </span>
      )}
      {usageCount > 1 && (
        <span className="gallery-reuse-indicator" title={`Used ${usageCount} times in this chat`} aria-label={`Attachment used ${usageCount} times in this chat`}>
          <Link size={14} /><span>{usageCount.toLocaleString()}</span>
        </span>
      )}
    </span>
  );
}
