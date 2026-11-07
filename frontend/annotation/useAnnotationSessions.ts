import { useCallback, useEffect, useState } from 'react';
import type { SessionItem } from './listModel';

/** The analysed videos with the progress of their annotation work. */
export function useAnnotationSessions() {
  const [items, setItems] = useState<SessionItem[]>();
  const [error, setError] = useState('');
  const load = useCallback(() => {
    setError('');
    return fetch('/api/annotation/sessions')
      .then(async response => {
        if (!response.ok) throw new Error((await response.text().catch(() => '')) || `Request failed (${response.status})`);
        return response.json() as Promise<{ sessions: SessionItem[] }>;
      })
      .then(body => setItems(body.sessions))
      .catch((reason: Error) => setError(reason.message));
  }, []);
  useEffect(() => { void load(); }, [load]);
  return { items, error, reload: load };
}
