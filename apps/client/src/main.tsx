import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

// Note: StrictMode is intentionally omitted. Its dev-only double-invoked effects
// destroy and then reuse the Yjs doc, which breaks the CRDT/IndexedDB binding.
createRoot(document.getElementById('root')!).render(<App />);
