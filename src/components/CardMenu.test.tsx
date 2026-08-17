// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { CardMenu, type CardMenuCloseReason } from './CardMenu';

/**
 * The contract, not the appearance.
 *
 * Focus policy is the half most likely to be «simplified» later into «always
 * return focus to the trigger», which looks tidy and is wrong in two of the
 * four cases — each of those two has a test here saying why.
 */

afterEach(cleanup);

/** Controlled wrapper, the way both real callers use it. */
function Harness({ onClose }: { onClose?: (reason?: CardMenuCloseReason) => void } = {}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button">снаружи</button>
      <CardMenu
        open={open}
        onOpenChange={(next, reason) => {
          setOpen(next);
          if (!next) onClose?.(reason);
        }}
        label="Меню записи"
        id="menu-1"
        items={[
          { key: 'a', label: 'Действие', onSelect: vi.fn() },
          { key: 'b', label: 'Ссылка', href: 'https://example.invalid/tx' },
        ]}
        hint="пояснение"
      />
    </div>
  );
}

const trigger = () => screen.getByRole('button', { name: 'Меню записи' });
const open = () => fireEvent.click(trigger());

describe('CardMenu — раскрытие', () => {
  it('закрыт по умолчанию и объявляет это', () => {
    render(<Harness />);
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('открытие связывает триггер с попапом через aria-controls', () => {
    render(<Harness />);
    open();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(trigger().getAttribute('aria-controls')).toBe('menu-1');
    expect(document.getElementById('menu-1')).not.toBeNull();
  });

  it('повторное нажатие на триггер закрывает', () => {
    render(<Harness />);
    open();
    fireEvent.click(trigger());
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('ссылка остаётся ссылкой — среднее нажатие и «открыть в новой вкладке» живы', () => {
    render(<Harness />);
    open();
    const link = screen.getByRole('menuitem', { name: 'Ссылка' }) as HTMLAnchorElement;
    expect(link.tagName).toBe('A');
    expect(link.href).toContain('example.invalid');
    expect(link.rel).toContain('noopener');
  });
});

describe('CardMenu — фокус возвращается ПО ПРИЧИНЕ', () => {
  it('Escape: закрывает и возвращает фокус на триггер', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    open();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onClose).toHaveBeenCalledWith('escape');
    expect(document.activeElement).toBe(trigger());
  });

  it('клик снаружи: закрывает и НЕ трогает фокус', () => {
    // У клика есть своя цель. Перетащить фокус обратно на триггер — значит
    // отменить осознанное перемещение пользователя.
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    open();
    const outside = screen.getByRole('button', { name: 'снаружи' });
    outside.focus();
    fireEvent.pointerDown(outside);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onClose).toHaveBeenCalledWith('outside');
    expect(document.activeElement).toBe(outside);
  });

  it('выбор пункта: закрывает и НЕ забирает фокус себе', async () => {
    // Действие обычно открывает диалог, которому фокус и нужен. Забрать его
    // первым — значит столкнуть две системы управления фокусом лбами.
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    open();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Действие' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledWith('select'));
    expect(document.activeElement).not.toBe(trigger());
  });

  it('размонтирование: ничего не фокусирует и не бросает', () => {
    // Блокировка раздела уносит и триггер. Дотянуться до отсоединённого узла —
    // ровно то, чем такой замок и падает.
    const { unmount } = render(<Harness />);
    open();
    expect(() => unmount()).not.toThrow();
    expect(document.activeElement).toBe(document.body);
  });
});

describe('CardMenu — Tab и повторный клик по триггеру', () => {
  it('Tab закрывает, но НЕ возвращает фокус — это отменило бы переход', () => {
    render(<Harness />);
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
    const first = screen.getAllByRole('menuitem')[0];
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement, 'фокус остаётся там, откуда Tab его понесёт дальше').not.toBe(trigger());
  });

  it('повторный клик по триггеру закрывает, фокус и так на нём', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    open();
    fireEvent.click(trigger());
    expect(onClose).toHaveBeenCalledWith('programmatic');
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('CardMenu — пункт может отменить закрытие', () => {
  function VetoHarness({ result }: { result: void | false }) {
    const [open, setOpen] = useState(true);
    return (
      <CardMenu
        open={open}
        onOpenChange={next => setOpen(next)}
        label="Меню"
        id="menu-veto"
        items={[{ key: 'copy', label: 'Копировать', onSelect: () => result }]}
      />
    );
  }

  it('обычный пункт закрывает меню', async () => {
    render(<VetoHarness result={undefined} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Копировать' }));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('вернувший false — оставляет открытым', async () => {
    // Запасной путь при отказе буфера обмена — выделить текст руками, а для
    // этого он должен остаться на экране.
    render(<VetoHarness result={false} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Копировать' }));
    // Пауза достаточная, чтобы закрытие успело бы произойти, если бы вето не работало.
    await new Promise(r => setTimeout(r, 20));
    expect(screen.queryByRole('menu')).not.toBeNull();
  });
});

describe('CardMenu — Escape не всплывает наружу', () => {
  it('внешний обработчик Escape не срабатывает, пока меню открыто', () => {
    // Иначе один Escape закроет и меню, и модалку под ним, и поиск.
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    try {
      render(<Harness />);
      open();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(outer).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', outer);
    }
  });
});
