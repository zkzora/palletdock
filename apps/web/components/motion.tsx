'use client';

import { useEffect, useRef } from 'react';

/** True when the user asked the system for reduced motion. */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Adds .in to every `.reveal` element inside the returned ref once it scrolls
 * into view (one-shot). Children can set style={{ '--i': n }} for stagger.
 */
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const items = Array.from(root.querySelectorAll<HTMLElement>('.reveal'));
    if (prefersReducedMotion() || typeof IntersectionObserver === 'undefined') {
      items.forEach((el) => el.classList.add('in'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0.12 },
    );
    items.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
  return ref;
}

/** Wrapper that reveals its `.reveal` descendants on scroll. */
export function Reveal({ children, className, style, as: Tag = 'div' }: { children: React.ReactNode; className?: string; style?: React.CSSProperties; as?: 'div' | 'section' | 'ol' | 'ul' }) {
  const ref = useReveal<HTMLDivElement>();
  return (
    <Tag ref={ref as never} className={className} style={style}>
      {children}
    </Tag>
  );
}

/** Elements that get the pointer spotlight (see motion.css). */
export const SPOT_SELECTOR = '.spot, .contract-card, .metric, .stat, .choice, .docs-card, .empty-state';

/**
 * Spotlight: a soft light follows the pointer across every `.spot` card under
 * the container (one listener per container, Supabase-style bento hover).
 */
export function useSpotlight<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (prefersReducedMotion()) return;
    // Document-level so it also covers content rendered after this hook mounts.
    const onMove = (e: PointerEvent) => {
      const card = (e.target as HTMLElement | null)?.closest?.<HTMLElement>(SPOT_SELECTOR);
      if (!card) return;
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${e.clientX - r.left}px`);
      card.style.setProperty('--my', `${e.clientY - r.top}px`);
    };
    document.addEventListener('pointermove', onMove, { passive: true });
    return () => document.removeEventListener('pointermove', onMove);
  }, []);
  return ref;
}

/** Hero backdrop: grid drifts with scroll (parallax) and a glow follows the pointer. */
export function useHeroParallax<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => el.style.setProperty('--py', `${Math.min(window.scrollY, 900) * 0.25}px`));
    };
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--gx', `${((e.clientX - r.left) / r.width) * 100}%`);
      el.style.setProperty('--gy', `${((e.clientY - r.top) / r.height) * 100}%`);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('pointermove', onMove);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
      el.removeEventListener('pointermove', onMove);
    };
  }, []);
  return ref;
}

/** Subtle 3D tilt toward the pointer (max ±4°), resets on leave. */
export function useTilt<T extends HTMLElement>(max = 4) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion() || window.matchMedia?.('(pointer: coarse)').matches) return;
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      el.style.setProperty('--ry', `${(x * max * 2).toFixed(2)}deg`);
      el.style.setProperty('--rx', `${(-y * max * 2).toFixed(2)}deg`);
      el.style.setProperty('--ty', '-4px');
    };
    const onLeave = () => {
      el.style.setProperty('--ry', '0deg');
      el.style.setProperty('--rx', '0deg');
      el.style.setProperty('--ty', '0px');
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerleave', onLeave);
    return () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
    };
  }, [max]);
  return ref;
}

/** Adds .is-scrolled to a sticky header after the page scrolls a little. */
export function useScrolledHeader<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const on = () => el.classList.toggle('is-scrolled', window.scrollY > 8);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  return ref;
}
