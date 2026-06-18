import { NextResponse, type NextRequest } from 'next/server';

// Password gate for the admin dashboard. It reads the service-role key and shows everyone's
// usage/cost data, so it must NEVER be open on a public URL. HTTP Basic Auth keeps it simple
// (one shared password set in the host's env). Fail CLOSED in production: if no password is
// configured, lock the whole site rather than expose it; local dev (no NODE_ENV=production) is open.
export function middleware(req: NextRequest) {
  const password = process.env.DASHBOARD_PASSWORD;
  const user = process.env.DASHBOARD_USER || 'admin';

  if (!password) {
    if (process.env.NODE_ENV === 'production') {
      return new NextResponse('Dashboard locked — set DASHBOARD_PASSWORD in the environment.', { status: 503 });
    }
    return NextResponse.next(); // local dev convenience
  }

  const header = req.headers.get('authorization');
  if (header?.startsWith('Basic ')) {
    try {
      const [u, p] = atob(header.slice(6)).split(':');
      if (u === user && p === password) return NextResponse.next();
    } catch { /* malformed header → fall through to challenge */ }
  }
  return new NextResponse('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Planfect Dashboard", charset="UTF-8"' },
  });
}

// Gate everything except Next's static assets.
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
