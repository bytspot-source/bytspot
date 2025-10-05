import React, { useEffect, useMemo, useState } from 'react';
import LoginModal from './LoginModal';
import { useSessionQuery, useAuditQuery, useHostTypesQuery, useOnboardingQuery, useUpsertOnboarding, useVenuesQuery, useCreateVenue, useUsersQuery, useAnalyticsQuery } from './queries';

type TabKey = 'venues' | 'users' | 'analytics' | 'audit' | 'host';

function AdminNav({ current, onNav, disabled }: { current: string; onNav: (k: string) => void; disabled?: boolean }) {
  const tabs: { key: TabKey; label: string }[] = [
    { key: 'venues', label: 'Venues' },
    { key: 'users', label: 'Users' },
    { key: 'analytics', label: 'Analytics' },
    { key: 'audit', label: 'Audit' },
    { key: 'host', label: 'Host Onboarding' },
  ];
  return (
    <nav style={{
      display: 'flex', gap: 'var(--space-sm)', padding: 'var(--space-sm)',
      borderBottom: '1px solid var(--color-border)', background: 'var(--color-bg)', color: 'var(--color-text)'
    }}>
      {tabs.map(t => (
        <button
          key={t.key}
          onClick={() => !disabled && onNav(t.key)}
          disabled={disabled}
          style={{
            padding: 'var(--space-sm) var(--space-md)', borderRadius: 'var(--radius-md)px',
            background: current === t.key ? 'color-mix(in oklab, var(--color-text) 12%, transparent)' : 'transparent',
            color: 'var(--color-text)', border: '1px solid var(--color-border)',
            cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1
          }}
        >{t.label}</button>
      ))}
    </nav>
  );
}

function useAuthz() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('access_token'));
  const headers = useMemo(() => token ? { Authorization: `Bearer ${token}` } : {}, [token]);
  const { data: session, refetch } = useSessionQuery(!!token);
  useEffect(() => { if (token) refetch(); }, [token]);
  return { token, setToken, session, headers, refresh: () => refetch() };
}

function VenuesPage() {
  const [title, setTitle] = useState('');
  const { data, isLoading, error } = useVenuesQuery(true);
  const createVenue = useCreateVenue();
  const items = data?.items || [];
  const create = async () => {
    await createVenue.mutateAsync({ title });
    setTitle('');
  };
  return (
    <div style={{ padding: 'var(--space-lg)', color: 'var(--color-text)', background: 'var(--color-bg)' }}>
      <h2>Venues</h2>
      <div style={{ display: 'flex', gap: 'var(--space-sm)', marginBottom: 'var(--space-md)' }}>
        <input
          value={title}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTitle(e.target.value)}
          placeholder="New venue title"
          style={{
            padding: 'var(--space-sm) var(--space-md)',
            borderRadius: 'var(--radius-md)px',
            border: '1px solid var(--color-border)',
            color: 'var(--color-text)', background: 'var(--color-bg)'
          }}
        />
        <button onClick={create} disabled={createVenue.isPending} style={{
          padding: 'var(--space-sm) var(--space-md)', borderRadius: 'var(--radius-md)px',
          background: 'var(--button-primary-bg, var(--color-accent))', color: 'var(--button-primary-fg, var(--color-bg))',
          border: '1px solid var(--button-primary-border, var(--color-accent))', cursor: 'pointer'
        }}>Create</button>
      </div>
      {isLoading && <div>Loading...</div>}
      {error && <div style={{ color: 'var(--color-danger, #fda4af)' }}>Failed to load venues</div>}
      <ul>
        {items.map((v: any) => (<li key={v.id}>{v.title} — {v.subtitle}</li>))}
      </ul>
    </div>
  );
}

function UsersPage() {
  const { data, isLoading, error } = useUsersQuery(true);
  const items = data?.items || [];
  return (
    <div style={{ padding: 16, color: '#fff' }}>
      <h2>Users</h2>
      {isLoading && <div>Loading...</div>}
      {error && <div style={{ color: '#fda4af' }}>Failed to load users</div>}
      <ul>
        {items.map((u: any) => (<li key={u.id}>{u.email} — {u.name}</li>))}
      </ul>
    </div>
  );
}

function AnalyticsPage() {
  const { data, isLoading, error } = useAnalyticsQuery(true);
  return (
    <div style={{ padding: 16, color: '#fff' }}>
      <h2>Analytics</h2>
      {isLoading && <div>Loading...</div>}
      {error && <div style={{ color: '#fda4af' }}>Failed to load analytics</div>}
      {!!data && (
        <>
          <p>Users: {data.users || 0}</p>
          <p>Venues: {data.venues || 0}</p>
          <p>Likes: {data.likes || 0}</p>
        </>
      )}
    </div>
  );
}

function AuditPage() {
  const { data, isLoading, error } = useAuditQuery(true);
  const items = data?.items || [];
  return (
    <div style={{ padding: 16, color: '#fff' }}>
      <h2>Admin Audit</h2>
      {isLoading && <div>Loading...</div>}
      {error && <div style={{ color: '#fda4af' }}>Failed to load audit</div>}
      <ul>
        {items.map((a: any) => (<li key={a.id}>{a.created_at} — {a.action} — {a.target_email} by {a.actor_id}</li>))}
      </ul>
    </div>
  );
}

function HostOnboardingPage() {
  const hostTypes = useHostTypesQuery();
  const onboarding = useOnboardingQuery(true);
  const upsert = useUpsertOnboarding();
  const [persisting, setPersisting] = useState<string | null>(null);

  const progress = onboarding.data?.progress ?? hostTypes.data?.progress ?? 0;
  const types = hostTypes.data?.types ?? [];

  const selectType = async (key: 'venue'|'parking'|'valet') => {
    setPersisting(key);
    try {
      await upsert.mutateAsync({ serviceType: key, progress: 30, data: { step: 'service-type' } });
      await onboarding.refetch();
    } finally {
      setPersisting(null);
    }
  };

  return (
    <div style={{ padding: 16, color: '#fff' }}>
      <h2>Host Onboarding</h2>
      <div style={{ height: 8, background: '#333', borderRadius: 6, overflow: 'hidden', margin: '8px 0 16px' }}>
        <div style={{ width: `${progress}%`, height: '100%', background: '#22c55e' }} />
      </div>
      <div style={{ display: 'grid', gap: 12 }}>
        {types.map((t: any) => (
          <div key={t.key} style={{ border: '1px solid #333', borderRadius: 8, padding: 12 }}>
            <strong>{t.label}</strong>
            <div style={{ color: '#bbb' }}>{t.description}</div>
            <div style={{ marginTop: 8 }}>
              <button disabled={persisting === t.key || upsert.isPending} onClick={() => selectType(t.key)}>
                {persisting === t.key ? 'Saving...' : 'Choose'}
              </button>
            </div>
          </div>
        ))}
      </div>
      {progress >= 30 && (
        <div style={{ marginTop: 16 }}>
          <button disabled={upsert.isPending} onClick={async () => { await upsert.mutateAsync({ progress: 50, data: { step: 'details' } }); await onboarding.refetch(); }}>Continue to details (50%)</button>
        </div>
      )}
    </div>
  );
}

export default function AdminApp() {
  const [tab, setTab] = useState<TabKey>('venues');
  const [showLogin, setShowLogin] = useState(false);
  const { token, setToken, session } = useAuthz();
  const isAdmin = !!session?.roles?.includes('admin');

  return (
    <div style={{ minHeight: '100vh', background: 'var(--color-bg)' }}>
      <div style={{ padding: 'var(--space-sm)', borderBottom: '1px solid var(--color-border)', color: 'var(--color-text)', display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
        {!token && (
          <>
            <button onClick={() => setShowLogin(true)} style={{
              padding: 'var(--space-sm) var(--space-md)', borderRadius: 'var(--radius-md)px',
              background: 'var(--button-ghost-bg, transparent)', color: 'var(--button-ghost-fg, var(--color-text))',
              border: '1px solid var(--button-ghost-border, var(--color-border))', cursor: 'pointer'
            }}>Sign in</button>
            <span style={{ opacity: 0.7 }}>(or paste a token):</span>
            <input style={{ width: '40%', padding: 'var(--space-sm)', borderRadius: 'var(--radius-md)px', border: '1px solid var(--color-border)', color: 'var(--color-text)', background: 'var(--input-bg, var(--color-bg))' }} onChange={(e: any) => { localStorage.setItem('access_token', e.target.value); setToken(e.target.value); }} />
          </>
        )}
        {token && !isAdmin && <div style={{ color: 'var(--color-danger, #fca5a5)' }}>Admin token required to access Admin pages.</div>}
        {token && isAdmin && <div>Signed in as {session?.sub} (admin)</div>}
      </div>
      <AdminNav current={tab} onNav={(k) => setTab(k as TabKey)} disabled={!isAdmin} />
      {isAdmin && (
        <>
          {tab === 'venues' && <VenuesPage />}
          {tab === 'users' && <UsersPage />}
          {tab === 'analytics' && <AnalyticsPage />}
          {tab === 'audit' && <AuditPage />}
          {tab === 'host' && <HostOnboardingPage />}
        </>
      )}
      {showLogin && (
        <LoginModal onClose={() => setShowLogin(false)} onLoggedIn={() => window.location.reload()} />
      )}
    </div>
  );
}

