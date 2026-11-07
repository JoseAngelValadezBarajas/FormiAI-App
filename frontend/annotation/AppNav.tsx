import { PAGES, type Route } from './route';

/**
 * Section navigation. These are links, not tabs: each section is a different page with its own address, so the
 * semantics are a navigation landmark with aria-current, which is what a screen reader expects for a router.
 */
export function AppNav({ route }: { route: Route }) {
  return (
    <nav className="app-nav" aria-label="Secciones">
      {PAGES.map(page => (
        <a key={page.id} href={page.href} className="app-nav-link" aria-current={route.page === page.id ? 'page' : undefined}>
          <span>{page.label}</span>
          <span className="app-nav-indicator" aria-hidden="true" />
        </a>
      ))}
    </nav>
  );
}
