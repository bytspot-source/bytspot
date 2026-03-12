import { HashRouter, Routes, Route } from 'react-router-dom';
import BetaSignupPage from './components/BetaSignup';
import WelcomeLanding from './components/WelcomeLanding';

function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<BetaSignupPage />} />
        <Route path="/welcome" element={<WelcomeLanding />} />
      </Routes>
    </HashRouter>
  );
}

export default App;
