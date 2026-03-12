import { BrowserRouter, Routes, Route } from 'react-router-dom';
import BetaSignupPage from './components/BetaSignup';
import WelcomeLanding from './components/WelcomeLanding';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<BetaSignupPage />} />
        <Route path="/welcome" element={<WelcomeLanding />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
