import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { WorkspaceApp } from './app/WorkspaceApp';

const root = document.getElementById('root');

if (!root) {
  throw new Error('React root element was not found.');
}

createRoot(root).render(
  <StrictMode>
    <WorkspaceApp />
  </StrictMode>,
);
