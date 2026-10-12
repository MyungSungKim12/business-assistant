import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { ApiClient } from './api/client';
import { App } from './app/App';
import { createBrowserPlatform } from './platform/browser';
import { createTauriPlatform } from './platform/tauri';

const root = document.getElementById('root');

if (!root) {
  throw new Error('React root element was not found.');
}

const platform = '__TAURI_INTERNALS__' in window ? await createTauriPlatform() : createBrowserPlatform();
const services = { platform, api: new ApiClient(platform) };
createRoot(root).render(<StrictMode><App services={services}/></StrictMode>);
