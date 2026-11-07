import { useEffect, useState } from 'react';

export type Route =
  | { page: 'observatory' }
  | { page: 'review' }
  | { page: 'annotation'; sessionId?: string };

export const PAGES = [
  { id: 'observatory', label: 'Observatorio', href: '#/observatorio' },
  { id: 'review', label: 'Review', href: '#/review' },
  { id: 'annotation', label: 'Anotación', href: '#/anotacion' },
] as const;

/** Hash routes keep this a static single-page app: no server rewrite is needed and links survive a reload. */
export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'review') return { page: 'review' };
  if (parts[0] === 'anotacion') {
    const id = parts[1] ? safeDecode(parts[1]) : undefined;
    return id ? { page: 'annotation', sessionId: id } : { page: 'annotation' };
  }
  return { page: 'observatory' };
}

function safeDecode(value: string): string | undefined {
  try { return decodeURIComponent(value); } catch { return undefined; }
}

export const annotationHref = (sessionId?: string) => (sessionId ? `#/anotacion/${encodeURIComponent(sessionId)}` : '#/anotacion');

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const update = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return route;
}

export const navigate = (href: string) => { window.location.hash = href.replace(/^#/, ''); };
