import type { Metadata } from 'next';
import { DM_Sans, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';

const dmSans = DM_Sans({
  subsets: ['latin'],
  variable: '--font-sans',
  weight: ['400', '500', '600', '700', '800'],
});

// IBM Plex Mono, taken from the UAS Dashboard deck — the fonts embedded in
// that PDF are IBMPlexMono Regular / Medium / SemiBold and nothing else. Mono
// is not decoration in that design: every number, label, code and date is set
// in it, and the sans is reserved for headings and prose. Matching the face is
// most of the difference between the app and the deck.
//
// SemiBold (600) is included because the deck leans on it for figures — the
// big "82.5" and every stat number. DM Mono stopped at 500, so a 600 request
// was silently rendering as 500.
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  weight: ['400', '500', '600'],
});

export const metadata: Metadata = {
  title: 'ORBoard — Anesthesia Command Center',
  description: 'Real-time OR staffing board for anesthesia teams',
};

// Applies a SAVED theme before React hydrates so a chosen preference never
// flashes. Light is the CSS default (:root), so a first-time visitor with no
// stored value needs nothing here; a saved 'dark' gets data-theme='dark' set
// pre-paint (otherwise the light default would flash before the toggle ran).
const themeInitScript = `(function(){try{var t=localStorage.getItem('theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${dmSans.variable} ${plexMono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
