import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';
import { HashRedirect } from './components/HashRedirect';
import { SiteShell } from './components/SiteShell';
import { HomePage } from './pages/HomePage';
import { HowItWorksPage } from './pages/HowItWorksPage';
import { HostPartyPage } from './pages/HostPartyPage';
import { InvitePage } from './pages/InvitePage';
import { ExternalRedirect } from './components/ExternalRedirect';
import { PRIVACY_URL, TERMS_URL } from './lib/site';
import { WelcomePage } from './pages/WelcomePage';
import { NotFoundPage } from './pages/NotFoundPage';

function App() {
  return (
    <BrowserRouter>
      <HashRedirect />
      <SiteShell>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/how-it-works" element={<HowItWorksPage />} />
          <Route path="/how" element={<Navigate to="/how-it-works" replace />} />
          <Route path="/host" element={<HostPartyPage />} />
          <Route path="/party" element={<Navigate to="/host" replace />} />
          <Route path="/invite" element={<InvitePage />} />
          <Route path="/welcome" element={<WelcomePage />} />
          <Route path="/legal" element={<ExternalRedirect to={TERMS_URL} />} />
          <Route path="/terms" element={<ExternalRedirect to={TERMS_URL} />} />
          <Route path="/privacy" element={<ExternalRedirect to={PRIVACY_URL} />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </SiteShell>
      <Toaster
        theme="dark"
        position="bottom-center"
        toastOptions={{
          style: {
            background: '#161B3A',
            border: '1px solid rgba(244, 239, 230, 0.14)',
            color: '#F4EFE6',
          },
        }}
      />
    </BrowserRouter>
  );
}

export default App;
