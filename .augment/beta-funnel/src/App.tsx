import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';
import { HashRedirect } from './components/HashRedirect';
import { SiteShell } from './components/SiteShell';
import { HomePage } from './pages/HomePage';
import { HowItWorksPage } from './pages/HowItWorksPage';
import { HostPartyPage } from './pages/HostPartyPage';
import { InviteClipPage } from './pages/InviteClipPage';
import {
  HostTermsPage,
  LegalIndexPage,
  PrivacyPage,
  TermsOfSalePage,
  TermsPage,
} from './pages/LegalPages';
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
          <Route path="/invite" element={<InviteClipPage />} />
          <Route path="/clip" element={<Navigate to="/invite" replace />} />
          <Route path="/welcome" element={<WelcomePage />} />
          <Route path="/legal" element={<LegalIndexPage />} />
          <Route path="/terms" element={<TermsPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/terms-of-sale" element={<TermsOfSalePage />} />
          <Route path="/host-terms" element={<HostTermsPage />} />
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
