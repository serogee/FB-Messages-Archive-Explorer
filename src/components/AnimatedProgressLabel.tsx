import { useEffect, useState } from 'react';

/** Animate locally so progress labels do not rerender chats or thumbnails. */
export function AnimatedProgressLabel({ children, active = true }: { children: string; active?: boolean }) {
  const [dots, setDots] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setDots(current => (current + 1) % 4), 500);
    return () => clearInterval(timer);
  }, [active]);
  return <span>{children}<span className="progress-ellipsis" aria-hidden="true">{active ? '.'.repeat(dots) : ''}</span></span>;
}
