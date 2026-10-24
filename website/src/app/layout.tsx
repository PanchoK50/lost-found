import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Lost & Found — Building navigator', description: 'Find your way around your building. Industrial Agents Hackathon team starter.' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
