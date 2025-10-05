import { createRoot } from 'react-dom/client';
import AdminApp from './AdminApp';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const qc = new QueryClient();

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={qc}>
    <AdminApp />
  </QueryClientProvider>
);

