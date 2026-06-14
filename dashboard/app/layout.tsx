import type { ReactNode } from 'react';

export const metadata = {
  title: 'Planfect — Developer Dashboard',
  description: 'Usage, cost, and model comparison',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#fafafa', color: '#111' }}>{children}</body>
    </html>
  );
}
