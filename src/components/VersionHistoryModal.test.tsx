// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { VersionHistoryModal } from './VersionHistoryModal';
import { groupChains } from '../lib/chains';
import type { NoteData } from '../lib/crypto';
import type { NoteSyncInfo } from '../lib/store';

// Eternity is a claim, and this modal made it in prose — under rows that could
// say the opposite. These tests pin the sentence to the statuses beside it.

const version = (id: string, over: Partial<NoteData> = {}): NoteData => ({
  id,
  text: `текст ${id}`,
  createdAt: 1_700_000_000_000,
  fmt: 'plain',
  rev: 1,
  root: 'r',
  ...over,
});

function show(statuses: Record<string, NoteSyncInfo>, syncActive = true) {
  const notes = [version('r'), version('v2', { rev: 2, prev: 'r' })];
  return render(
    <VersionHistoryModal
      open
      chain={groupChains(notes)[0]}
      syncStatuses={statuses}
      syncActive={syncActive}
      onClose={vi.fn()}
      onRequestRestore={vi.fn()}
    />,
  );
}

const note = () => document.querySelector('.modal-note')?.textContent ?? '';

afterEach(cleanup);

describe('VersionHistoryModal — обещание вечности', () => {
  it('обещает блокчейн, только когда ВСЕ версии подтверждены', () => {
    show({ r: { status: 'confirmed' }, v2: { status: 'confirmed' } });
    expect(note()).toContain('навсегда сохранена в блокчейне');
  });

  it('одна неподтверждённая версия снимает обещание со всей истории', () => {
    show({ r: { status: 'confirmed' }, v2: { status: 'queued' } });
    expect(note()).not.toContain('навсегда сохранена в блокчейне');
    expect(note()).toContain('ещё не сохранены в блокчейне');
  });

  it('синхронизация выключена и версий в сети нет — обещания нет', () => {
    // Все строки читаются как «на устройстве»: блокчейна тут не было вовсе.
    show({}, false);
    expect(note()).not.toContain('навсегда сохранена в блокчейне');
    expect(screen.getAllByText('на устройстве').length).toBe(2);
  });

  it('выключенная синхронизация НЕ отменяет уже подтверждённые версии', () => {
    // `confirmed` — факт о сети, а не о положении переключателя: строки
    // по-прежнему говорят «навечно», значит и сноска вправе.
    show({ r: { status: 'confirmed' }, v2: { status: 'confirmed' } }, false);
    expect(note()).toContain('навсегда сохранена в блокчейне');
  });

  it('про возврат версии сказано всегда — это верно при любом статусе', () => {
    show({ r: { status: 'error' }, v2: { status: 'error' } });
    expect(note()).toContain('создаёт новую версию с её текстом');
  });
});

describe('VersionHistoryModal — статус ошибки ничего не обещает', () => {
  it('не называет себя кнопкой повтора: нажать её тут нельзя', () => {
    show({ r: { status: 'error' }, v2: { status: 'error' } });

    // Строка — это <button> раскрытия; статус внутри неё лишь текст.
    const state = document.querySelector('.sync-state--error');
    expect(state?.tagName).toBe('SPAN');
    expect(state?.getAttribute('aria-label')).toBe('Ошибка загрузки');
    expect(state?.getAttribute('aria-label')).not.toMatch(/повторить/);
    expect(document.querySelector('.sync-state--retry')).toBeNull();
  });
});

describe('VersionHistoryModal — ∞ рядом с «навечно»', () => {
  it('подтверждённая версия получает знак, как в ленте и сейфе', () => {
    show({ r: { status: 'confirmed' }, v2: { status: 'confirmed' } });
    const permanent = document.querySelectorAll('.sync-state--permanent');
    expect(permanent).toHaveLength(2);
    expect(permanent[0].querySelector('svg')).toBeTruthy();
  });

  it('версия в очереди знака не получает', () => {
    show({ r: { status: 'queued' }, v2: { status: 'queued' } });
    expect(document.querySelector('.sync-state--queued svg')).toBeNull();
    expect(screen.getAllByText('в очереди').length).toBe(2);
  });
});
