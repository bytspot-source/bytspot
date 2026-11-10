import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, Mail } from 'lucide-react';
import { toast } from 'sonner';
import { SIGNUP_API_URL } from '../lib/site';
import { AppStoreButton } from './AppStoreButton';

interface SubmitResult {
  ok: boolean;
  alreadyRegistered?: boolean;
  message?: string;
}

async function submitEmail(email: string, name?: string): Promise<SubmitResult> {
  const res = await fetch(SIGNUP_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name, source: 'bytspot.com' }),
  });
  if (!res.ok) return { ok: false, message: 'Signup failed. Please try again.' };
  const data = (await res.json().catch(() => ({}))) as { alreadyRegistered?: boolean };
  return { ok: true, alreadyRegistered: data.alreadyRegistered ?? false };
}

export function EmailUpdatesForm({ compact = false }: { compact?: boolean }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [already, setAlready] = useState(false);

  useEffect(() => {
    if (localStorage.getItem('bytspot_beta_signed_up')) {
      setAlready(true);
      setIsSuccess(true);
    }
  }, []);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!email) {
      toast.error('Please enter your email');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast.error('Please enter a valid email');
      return;
    }
    setIsSubmitting(true);
    try {
      const result = await submitEmail(email, name.trim() || undefined);
      if (result.ok) {
        setIsSuccess(true);
        setAlready(Boolean(result.alreadyRegistered));
        localStorage.setItem('bytspot_beta_signed_up', 'true');
        localStorage.setItem('bytspot_beta_email', email);
        if (name.trim()) localStorage.setItem('bytspot_beta_name', name.trim());
        toast.success(
          result.alreadyRegistered
            ? "You're already on the list."
            : "You're on the list.",
          { description: "We'll email you Bytspot updates for Atlanta." },
        );
      } else {
        toast.error(result.message || 'Something went wrong.');
      }
    } catch {
      toast.error('Network error. Please check your connection.');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isSuccess) {
    return (
      <div className="space-y-4 rounded-2xl border border-[var(--line)] bg-[var(--navy)]/60 p-6">
        <Mail className="h-8 w-8 text-[var(--cyan)]" aria-hidden="true" />
        <h3 className="text-xl font-semibold tracking-tight">
          {already ? "You're already on the list" : 'Thanks — you’re on the list'}
        </h3>
        <p className="text-sm leading-relaxed text-[var(--bone-muted)]">
          We’ll email you Bytspot updates for Atlanta. If you have an iPhone, the app is
          already on the App Store.
        </p>
        <AppStoreButton />
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {!compact && (
        <p className="text-sm text-[var(--bone-muted)]">
          Not on iPhone yet? Get Bytspot updates by email.
        </p>
      )}
      <label className="block">
        <span className="sr-only">First name (optional)</span>
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="First name (optional)"
          autoComplete="given-name"
          className="w-full rounded-xl border border-[var(--line)] bg-white/5 px-4 py-3.5 text-[16px] text-[var(--bone)] placeholder:text-[var(--bone-muted)] focus:border-[var(--cyan)] focus:outline-none"
        />
      </label>
      <label className="block">
        <span className="sr-only">Email</span>
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="Email address"
          autoComplete="email"
          required
          className="w-full rounded-xl border border-[var(--line)] bg-white/5 px-4 py-3.5 text-[16px] text-[var(--bone)] placeholder:text-[var(--bone-muted)] focus:border-[var(--cyan)] focus:outline-none"
        />
      </label>
      <p className="text-[12px] text-[var(--bone-muted)]">
        We’ll email you Bytspot updates for Atlanta. Unsubscribe anytime.
      </p>
      <button
        type="submit"
        disabled={isSubmitting}
        className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-[var(--cyan)] px-5 py-3 font-semibold text-[var(--navy-deep)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-70"
      >
        {isSubmitting ? (
          <span>Sending…</span>
        ) : (
          <>
            Get updates
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </>
        )}
      </button>
    </form>
  );
}
