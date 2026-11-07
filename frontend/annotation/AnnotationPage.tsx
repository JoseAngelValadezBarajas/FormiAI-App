import { SessionList } from './SessionList';
import { Workspace } from './Workspace';
import type { Route } from './route';

/** The Anotación section: the list of analysed videos, or the workspace of the one chosen in the address. */
export function AnnotationPage({ route }: { route: Extract<Route, { page: 'annotation' }> }) {
  return route.sessionId ? <Workspace key={route.sessionId} sessionId={route.sessionId} /> : <SessionList />;
}
