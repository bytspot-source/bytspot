import { Link } from 'react-router-dom';
import { DocumentTitle } from '../components/DocumentTitle';

export function NotFoundPage() {
  return (
    <>
      <DocumentTitle title="Page not found — Bytspot" />
      <article className="mx-auto max-w-xl px-5 py-24 text-center">
        <h1 className="text-4xl font-semibold tracking-tight">Page not found</h1>
        <p className="mt-4 text-[var(--bone-muted)]">
          That link isn&apos;t a page on bytspot.com.
        </p>
        <Link to="/" className="mt-8 inline-block font-semibold text-[var(--cyan)] hover:text-white">
          Back to Bytspot
        </Link>
      </article>
    </>
  );
}
