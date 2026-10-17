import type { Metadata } from 'next';
import { Instrument_Sans, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import './workspace.css';
import './motion.css';

const instrument = Instrument_Sans({ subsets: ['latin'], variable: '--font-instrument', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'PalletDock', template: '%s · PalletDock' },
  description: 'A developer workspace for Portaldot contracts, indexed data, and project APIs.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className={`${instrument.variable} ${mono.variable}`}><body>{children}</body></html>;
}
