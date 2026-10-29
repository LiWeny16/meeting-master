import React from 'react';
import ReactDOM from 'react-dom/client';
import { CacheProvider } from '@emotion/react';
import createCache from '@emotion/cache';
import { App } from './app/App';

// Tauri adds a per-response nonce to the startup style and the CSP. Reuse it
// for Emotion's runtime styles so MUI components render in production builds.
const nonce = document.querySelector<HTMLStyleElement>('#app-startup-style')?.nonce || undefined;
const emotionCache = createCache({ key: 'css', nonce });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CacheProvider value={emotionCache}><App /></CacheProvider>
  </React.StrictMode>,
);
