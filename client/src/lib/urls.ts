// The app is served under a path prefix (see `base` in vite.config.ts), so nothing may be
// addressed from the root: the portfolio lives there. Vite fills BASE_URL from `base` at build
// time and it always ends with a slash.
const base = import.meta.env.BASE_URL;

/** Absolute URL for a server route, e.g. apiUrl('/api/rooms') -> '/puzzlelove/api/rooms'. */
export function apiUrl(path: string): string {
  return base + path.replace(/^\//, '');
}

/** The game's home, for the raw <a> links that deliberately reload the whole page. */
export const homeUrl = base;

/** Socket.IO endpoint. Traefik strips the prefix, so the server keeps the default path. */
export const socketPath = `${base}socket.io`;
