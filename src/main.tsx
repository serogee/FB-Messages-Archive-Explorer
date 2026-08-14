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
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
