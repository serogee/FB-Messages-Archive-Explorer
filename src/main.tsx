import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/variables.css';
import './styles/reset.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/chat.css';
import './styles/chat-list.css';
import './styles/sidebar.css';
import './styles/modals.css';
import './styles/media-viewer.css';
import './styles/attachment-gallery.css';
import { ErrorBoundary } from './components/ErrorBoundary';
import App from './App';

// ── Global error handlers ──────────────────────────────────────────
window.onerror = (_message, _source, _lineno, _colno, error) => {
  console.error('[Global] Uncaught error:', error);
};

window.onunhandledrejection = (event: PromiseRejectionEvent) => {
  console.error('[Global] Unhandled promise rejection:', event.reason);
};

// ── Render ─────────────────────────────────────────────────────────
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
