import { useEffect } from 'react';

export function DocumentTitle({ title, description }: { title: string; description?: string }) {
  useEffect(() => {
    const previous = document.title;
    document.title = title;
    let meta = document.querySelector('meta[name="description"]');
    const previousDescription = meta?.getAttribute('content') ?? '';
    if (description) {
      if (!meta) {
        meta = document.createElement('meta');
        meta.setAttribute('name', 'description');
        document.head.appendChild(meta);
      }
      meta.setAttribute('content', description);
    }
    return () => {
      document.title = previous;
      if (meta && description) meta.setAttribute('content', previousDescription);
    };
  }, [title, description]);

  return null;
}
