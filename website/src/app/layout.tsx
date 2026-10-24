import type { Metadata, Viewport } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Lost & Found — Building navigator', description: 'Find your way around your building. Industrial Agents Hackathon team starter.' };
// Phone-first: fill the screen edge to edge (safe areas handled in CSS) and let the keyboard resize the layout.
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', interactiveWidget: 'resizes-content', themeColor: '#f2f2ee' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
