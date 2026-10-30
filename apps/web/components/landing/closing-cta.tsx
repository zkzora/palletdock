import Image from 'next/image';
import Link from 'next/link';
import { PlaygroundOr } from '@/components/playground-cta';

/** Closing call to action over a faint crop of the hero image. */
export function ClosingCta() {
  return (
    <section className="ld-cta" aria-labelledby="cta-title">
      <div className="ld-cta-art" aria-hidden="true">
        <Image src="/palletdock-hero-v1.png" alt="" fill sizes="100vw" />
      </div>
      <div className="container ld-cta-inner">
        <h2 id="cta-title" className="ld-display">Start with your first contract.</h2>
        <p className="muted">
          Run the self-hosted workspace, connect your wallet to Portaldot V3 Testnet, and follow one contract from deployment to an indexed API query.
        </p>
        <div className="ld-cta-actions">
          <PlaygroundOr
            playground={
              <>
                <Link href="/playground" className="button arrow-link">
                  Try Playground <span className="arrow" aria-hidden="true">→</span>
                </Link>
                <Link href="/login" className="button secondary">
                  Open workspace
                </Link>
              </>
            }
            fallback={
              <Link href="/login" className="button arrow-link">
                Open workspace <span className="arrow" aria-hidden="true">→</span>
              </Link>
            }
          />
          <Link href="/docs/getting-started" className="button secondary">
            Read setup guide
          </Link>
        </div>
      </div>
    </section>
  );
}
