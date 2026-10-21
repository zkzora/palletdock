import Image from 'next/image';
import Link from 'next/link';

const REPO_URL = process.env.NEXT_PUBLIC_PALLETDOCK_REPO_URL ?? 'https://github.com/zkzora/palletdock';
const GUIDE_URL = 'https://github.com/ItsCogumellum/portaldot-v3-testnet-guide';
const CONSOLE_URL = 'https://node-console.portaldot.dev/';

/** Footer columns: only pages and resources PalletDock actually has. */
const COLUMNS: Array<[string, Array<[string, string]>]> = [
  ['Product', [['Workflow', '/#workflow'], ['Scope', '/#scope'], ['Open workspace', '/login'], ['Roadmap', '/roadmap']]],
  ['Build', [['Getting started', '/docs/getting-started'], ['Network setup', '/docs/network'], ['Accounts', '/docs/accounts'], ['Funding', '/docs/funding'], ['Deploy', '/docs/deploy'], ['Contracts', '/docs/contracts']]],
  ['Operate', [['Transactions', '/docs/transactions'], ['Indexer', '/docs/indexer'], ['Read API', '/docs/api'], ['Monitoring', '/docs/monitoring']]],
  ['Resources', [['Documentation', '/docs'], ['FAQ', '/faq'], ['Troubleshooting', '/docs/troubleshooting'], ['Glossary', '/docs/glossary'], ['Security', '/docs/security'], ['Limitations', '/docs/limitations']]],
  ['Connect', [['Support', '/support'], ['Repository', REPO_URL], ['Portaldot guide', GUIDE_URL], ['Node console', CONSOLE_URL]]],
];

export function SiteFooter({ wide }: { wide?: boolean }) {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner" style={wide ? ({ '--footer-max': '1272px' } as React.CSSProperties) : undefined}>
        <div className="site-footer-brand">
          <Link href="/" aria-label="PalletDock home">
            <Image src="/palletdock-logo.png" alt="PalletDock" width={2172} height={724} style={{ width: 'auto', height: 36, filter: 'invert(1)', margin: '-6px' }} />
          </Link>
        </div>
        {COLUMNS.map(([title, links]) => (
          <nav key={title} className="site-footer-col" aria-label={title}>
            <h3>{title}</h3>
            <ul>
              {links.map(([label, href]) =>
                href.startsWith('http') ? (
                  <li key={label}>
                    <a href={href} target="_blank" rel="noopener noreferrer">
                      {label}
                    </a>
                  </li>
                ) : (
                  <li key={label}>
                    <Link href={href}>{label}</Link>
                  </li>
                ),
              )}
            </ul>
          </nav>
        ))}
        <p className="site-footer-legal">PalletDock · independent developer tooling for Portaldot. Not an official Portaldot product; its API is not an official Portaldot RPC specification.</p>
      </div>
    </footer>
  );
}
