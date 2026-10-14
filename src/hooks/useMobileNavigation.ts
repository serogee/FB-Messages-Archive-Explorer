import { useEffect, useState, useSyncExternalStore } from 'react';
import { MobileNavigationController } from '../services/mobileNavigation';

export const MOBILE_QUERY = '(max-width: 768px)';

export function useMobileLayout() {
  const [mobile, setMobile] = useState(() => window.matchMedia?.(MOBILE_QUERY).matches ?? window.innerWidth <= 768);
  useEffect(() => {
    const query = window.matchMedia?.(MOBILE_QUERY);
    const update = () => setMobile(query?.matches ?? window.innerWidth <= 768);
    if (query) query.addEventListener('change', update);
    else window.addEventListener('resize', update);
    update();
    return () => {
      if (query) query.removeEventListener('change', update);
      else window.removeEventListener('resize', update);
    };
  }, []);
  return mobile;
}

export function useMobileNavigation(mobile: boolean) {
  const [controller] = useState(() => new MobileNavigationController(window));
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  useEffect(() => controller.connect(), [controller]);
  useEffect(() => controller.setMobile(mobile), [controller, mobile]);
  return { controller, state };
}
