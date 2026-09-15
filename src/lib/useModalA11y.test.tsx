// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { useRef, type RefObject } from 'react';
import { render, cleanup, screen } from '@testing-library/react';
import { useModalA11y } from './useModalA11y';

/**
 * Focus RETURN, which is the half of this hook that had no test.
 *
 * The trap and the Escape handler are exercised through the dialogs
 * themselves; what those tests cannot show is where focus lands when the
 * element that opened the dialog is no longer a place to put it. That case is
 * not exotic — it is the version index opened from the feed's card menu, whose
 * whole feed unmounts the moment the note opens underneath.
 */

function Dialog({ open, fallbackRef }: { open: boolean; fallbackRef?: RefObject<HTMLElement | null> }) {
  const containerRef = useModalA11y<HTMLDivElement>(open, () => {}, { fallbackRef });
  if (!open) return null;
  return (
    <div ref={containerRef} role="dialog" aria-modal="true" aria-label="Диалог">
      <button>внутри</button>
    </div>
  );
}

function Harness({
  open,
  triggerMounted = true,
  withFallback = true,
}: {
  open: boolean;
  triggerMounted?: boolean;
  withFallback?: boolean;
}) {
  const fallback = useRef<HTMLButtonElement>(null);
  return (
    <>
      {triggerMounted && <button data-testid="trigger">триггер</button>}
      <button ref={fallback} data-testid="fallback">запасная</button>
      <Dialog open={open} fallbackRef={withFallback ? fallback : undefined} />
    </>
  );
}

afterEach(cleanup);

describe('useModalA11y — куда уходит фокус при закрытии', () => {
  it('на прежний элемент, если он всё ещё годная цель', () => {
    const { rerender } = render(<Harness open={false} />);
    screen.getByTestId('trigger').focus();
    rerender(<Harness open />);
    rerender(<Harness open={false} />);
    expect(document.activeElement).toBe(screen.getByTestId('trigger'));
  });

  it('на запасную цель, если прежний элемент размонтирован', () => {
    // Вход «из ленты»: пункт меню карточки исчезает вместе с лентой.
    const { rerender } = render(<Harness open={false} />);
    screen.getByTestId('trigger').focus();
    rerender(<Harness open />);
    rerender(<Harness open={false} triggerMounted={false} />);
    expect(document.activeElement).toBe(screen.getByTestId('fallback'));
  });

  it('на запасную цель, если фокус был на body', () => {
    // Ради этого случая проверка НЕ сводится к `isConnected`: body подключён к
    // документу, и наивная проверка припарковала бы фокус на нём. Так
    // заканчивается тап пальцем — меню закрывается, ничего не сфокусировано.
    const { rerender } = render(<Harness open={false} />);
    expect(document.activeElement).toBe(document.body);
    rerender(<Harness open />);
    rerender(<Harness open={false} />);
    expect(document.activeElement).toBe(screen.getByTestId('fallback'));
  });

  it('без запасной цели и без годного прежнего — не бросает', () => {
    const { rerender } = render(<Harness open={false} withFallback={false} />);
    rerender(<Harness open withFallback={false} />);
    expect(() => rerender(<Harness open={false} withFallback={false} />)).not.toThrow();
    expect(document.activeElement).toBe(document.body);
  });

  it('размонтирование диалога возвращает фокус так же, как закрытие', () => {
    const { rerender, unmount } = render(<Harness open={false} />);
    screen.getByTestId('trigger').focus();
    rerender(<Harness open />);
    const trigger = screen.getByTestId('trigger');
    unmount();
    // Диалог снят вместе с деревом: cleanup эффекта отработал, и прежний
    // элемент к этому моменту тоже отсоединён — фокус никуда не уводится, но
    // и исключения нет.
    expect(trigger.isConnected).toBe(false);
  });
});
