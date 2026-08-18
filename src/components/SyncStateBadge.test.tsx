// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { SyncStateBadge } from './SyncStateBadge';
import { SYNC_BADGE, LOCAL_ONLY_BADGE } from './syncBadge';

// Лента и сейф рисовали этот бейдж двумя копиями одного JSX, и копии разъехались:
// хром кнопки повтора переехал на --retry только в ленте, а сейф остался без
// рамки, без курсора и без 44px, с подписью, где слова «повторить» уже не было.

afterEach(cleanup);

describe('SyncStateBadge — состояние, на которое можно нажать', () => {
  it('несёт --retry, иначе теряет рамку и площадь касания', () => {
    render(<SyncStateBadge badge={SYNC_BADGE.error} onRetry={vi.fn()} />);
    const btn = document.querySelector('button');
    expect(btn?.className).toContain('sync-state--error');
    expect(btn?.className).toContain('sync-state--retry');
  });

  it('доступное имя говорит о повторе, а видимый текст ему не противоречит', () => {
    render(<SyncStateBadge badge={SYNC_BADGE.error} onRetry={vi.fn()} />);
    const btn = document.querySelector('button');
    expect(btn?.getAttribute('aria-label')).toBe('Ошибка загрузки — повторить');
    expect(btn?.getAttribute('title')).toBe('Ошибка загрузки — повторить');
    expect(btn?.textContent).toContain('повторить');
  });

  it('нажатие действительно вызывает повтор', () => {
    const onRetry = vi.fn();
    render(<SyncStateBadge badge={SYNC_BADGE.error} onRetry={onRetry} />);
    fireEvent.click(document.querySelector('button')!);
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe('SyncStateBadge — состояние, которое только сообщают', () => {
  it('без onRetry это не кнопка и повтора не обещает', () => {
    // Ошибка без права на повтор: синхронизация выключена.
    render(<SyncStateBadge badge={SYNC_BADGE.error} />);
    expect(document.querySelector('button')).toBeNull();
    const span = document.querySelector('span.sync-state');
    expect(span?.getAttribute('aria-label')).toBe('Ошибка загрузки');
    expect(span?.className).not.toContain('sync-state--retry');
    expect(span?.getAttribute('role')).toBe('status');
  });

  it('∞ стоит только у подтверждённой записи', () => {
    render(<SyncStateBadge badge={SYNC_BADGE.confirmed} />);
    expect(document.querySelector('svg')).toBeTruthy();

    cleanup();
    render(<SyncStateBadge badge={SYNC_BADGE.queued} />);
    expect(document.querySelector('svg')).toBeNull();

    cleanup();
    render(<SyncStateBadge badge={LOCAL_ONLY_BADGE} />);
    expect(document.querySelector('svg')).toBeNull();
  });
});
