import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, DASHBOARD_CHOICE } from './App.tsx';
import './styles.css';

// The owner last chose the second dashboard, in Vue and Quasar: it opens instead, on the same
// view. Only from /, so that /next/, answered by this page where the other isn't built, stays here.
if (localStorage.getItem(DASHBOARD_CHOICE) === 'next' && location.pathname === '/') {
  location.replace(`/next/${location.hash}`);
} else {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
