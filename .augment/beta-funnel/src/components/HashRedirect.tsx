import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

/** Honor legacy HashRouter links such as /#/welcome. */
export function HashRedirect() {
  const navigate = useNavigate();

  useEffect(() => {
    const { hash } = window.location;
    if (!hash.startsWith('#/')) return;
    const next = hash.slice(1);
    window.history.replaceState(null, '', next);
    navigate(next, { replace: true });
  }, [navigate]);

  return null;
}
