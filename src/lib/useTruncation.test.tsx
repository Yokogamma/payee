// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { useRef } from 'react';
import { render, cleanup } from '@testing-library/react';
import { useTruncation } from './useTruncation';

/**
 * jsdom does no layout: every box is 0×0 and `line-height` reads back as the
 * unitless `1.55`. So the sizes are stubbed and the hook is exercised on the
 * arithmetic and the guards — the parts that decide whether a card is cut.
 */
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const LINE = 27.9; // 18px × 1.55, the reading size

function stub({ scrollHeight, lineHeight = `${LINE}px` }: { scrollHeight: number; lineHeight?: string }) {
  vi.spyOn(window, 'getComputedStyle').mockImplementation(
    () => ({ lineHeight }) as unknown as CSSStyleDeclaration,
  );
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
  });
}

function Probe({ lines = 4, contentKey = 'k' }: { lines?: number; contentKey?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const truncated = useTruncation(ref, { lines, contentKey });
  return <div ref={ref} data-truncated={truncated ? 'yes' : 'no'} />;
}

const verdict = (c: HTMLElement) => c.querySelector('div')?.getAttribute('data-truncated');

describe('useTruncation', () => {
  it('clamps a note that overflows the ceiling by more than the tolerance', () => {
    // Six lines against a four-line ceiling.
    stub({ scrollHeight: LINE * 6 });
    const { container } = render(<Probe />);
    expect(verdict(container)).toBe('yes');
  });

  it('does NOT clamp within the tolerance — a card cut by six pixels reads as breakage', () => {
    // Four lines plus half a line: over the ceiling, inside the ¾-line grace.
    stub({ scrollHeight: LINE * 4 + LINE * 0.5 });
    const { container } = render(<Probe />);
    expect(verdict(container)).toBe('no');
  });

  it('does not clamp a note that fits', () => {
    stub({ scrollHeight: LINE * 2 });
    const { container } = render(<Probe />);
    expect(verdict(container)).toBe('no');
  });

  it('bails on a unitless line-height instead of guessing', () => {
    // THE jsdom CASE, and the reason the open control is never conditional on
    // this verdict: with no usable line-height the hook must answer «not
    // truncated» and leave the DOM alone rather than clamp on nonsense.
    stub({ scrollHeight: LINE * 20, lineHeight: '1.55' });
    const { container } = render(<Probe />);
    expect(verdict(container)).toBe('no');
  });

  it('survives an environment without ResizeObserver or document.fonts', () => {
    const ro = globalThis.ResizeObserver;
    const fonts = (document as Document & { fonts?: unknown }).fonts;
    // @ts-expect-error — deleting a global for the duration of the test
    delete globalThis.ResizeObserver;
    Object.defineProperty(document, 'fonts', { configurable: true, value: undefined });
    try {
      stub({ scrollHeight: LINE * 6 });
      const { container } = render(<Probe />);
      expect(verdict(container)).toBe('yes');
    } finally {
      globalThis.ResizeObserver = ro;
      Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
    }
  });

  it('re-measures when the CONTENT changes, at an unchanged width', () => {
    // The invalidator's whole point: an edit, a version arriving from sync, or
    // the markdown ⇄ search switch changes the height, not the width — and the
    // observer deliberately ignores height-only changes, so without the key
    // the stale verdict would stand.
    stub({ scrollHeight: LINE * 6 });
    const { container, rerender } = render(<Probe contentKey="v1" />);
    expect(verdict(container)).toBe('yes');

    stub({ scrollHeight: LINE * 2 });
    rerender(<Probe contentKey="v2" />);
    expect(verdict(container)).toBe('no');

    stub({ scrollHeight: LINE * 9 });
    rerender(<Probe contentKey="v3" />);
    expect(verdict(container)).toBe('yes');
  });
});
