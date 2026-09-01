import { createRoot } from 'react-dom/client';
import App from './App';
import { useDesignStore } from './store/useDesignStore';
import { api } from './ipc/api';

const el = document.getElementById('root')!;
createRoot(el).render(<App />);

// Dev-only debug bridge: lets automated drivers read/drive document state directly.
if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
  (window as unknown as Record<string, unknown>).__neouxe = { store: useDesignStore, api };
}
