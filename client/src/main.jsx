import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import toast, { Toaster } from 'react-hot-toast';
// Design system fonts (free, self-hosted; a font file downloads only when a page uses it).
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import './index.css';
import { AuthProvider } from './context/AuthContext.jsx';
import App, { warmRoute } from './App.jsx';
import { ConfirmHost } from './components/confirm.jsx';
import { registerServiceWorker } from './lib/pwa.js';
import { flushOutbox } from './lib/offline.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,
      // Login problems and missing things won't fix themselves on a retry.
      retry: (count, err) => count < 2 && ![400, 401, 403, 404].includes(err?.status),
      refetchOnWindowFocus: true,
    },
  },
});

// Installable app and push (E14).
registerServiceWorker();
// Comments written offline go out when the connection is back (and on start, in case it already is).
const flush = () => flushOutbox({
  onSent: (item) => { toast.success(`Sent your comment on ${item.label}`); queryClient.invalidateQueries(); },
  onDropped: (item, err) => toast.error(`Your comment on ${item.label} could not be sent: ${err.message}`),
});
window.addEventListener('online', flush);
setTimeout(flush, 2000);

// Right after the first frame (the boot mark) is painted, so the warm-up never delays it, and
// still well before the sign-in check answers.
requestAnimationFrame(() => setTimeout(() => warmRoute(window.location.pathname, queryClient), 0));
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
          <ConfirmHost />
          <Toaster
            position="bottom-right"
            toastOptions={{
              className: '!rounded-card !bg-overlay !font-ui !text-small !text-fg !shadow-overlay',
            }}
          />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
