import { ArrowLeft, Images, Info, List, MessageSquare } from 'lucide-react';
import { ENABLE_CONTEXTUAL_BACK_NAVIGATION } from '../../config/uiFeatures';
import './parent-back-button.css';

export function ParentBackButton({ destination, ariaLabel, onClick, className = 'mobile-back-btn' }: {
  destination: 'chats' | 'chat' | 'info' | 'attachments';
  ariaLabel: string;
  onClick?: () => void;
  className?: string;
}) {
  const DestinationIcon = destination === 'chat' ? MessageSquare : destination === 'attachments' ? Images : List;
  return <button type="button" className={`${className} parent-back-button`} onClick={onClick} aria-label={ariaLabel} title={ariaLabel}>
    {ENABLE_CONTEXTUAL_BACK_NAVIGATION ? <span className="parent-back-glyph" aria-hidden="true" data-destination={destination}>
      <ArrowLeft size={22} className="parent-back-arrow" />
      <DestinationIcon size={11} className="parent-back-destination" />
      {destination === 'info' && <Info size={8} className="parent-back-info" />}
    </span> : <ArrowLeft size={22} aria-hidden="true" />}
  </button>;
}
