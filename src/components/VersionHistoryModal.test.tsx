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
      onOpenVersion={vi.fn()}
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

describe('VersionHistoryModal — указатель, а не читалка', () => {
  const notes = [
    version('r', { createdAt: new Date(2026, 7, 13, 9, 5).getTime() }),
    version('v2', { rev: 2, prev: 'r', createdAt: new Date(2026, 7, 13, 14, 22).getTime() }),
  ];

  function index(onOpenVersion = vi.fn()) {
    render(
      <VersionHistoryModal
        open
        chain={groupChains(notes)[0]}
        syncStatuses={{}}
        syncActive={false}
        onClose={vi.fn()}
        onOpenVersion={onOpenVersion}
      />,
    );
    return onOpenVersion;
  }

  it('строка ведёт наружу, а не раскрывается на месте', () => {
    const onOpenVersion = index();
    // Раскрывать в указателе нечего — версия открывается страницей.
    expect(document.querySelector('.history-row-body')).toBeNull();
    screen.getByText(/Версия 1 из 2/).click();
    expect(onOpenVersion).toHaveBeenCalledWith(1);
  });

  it('текущую называет слово, а не рамка', () => {
    index();
    expect(screen.getByText(/· текущая/)).toBeTruthy();
    expect(document.querySelector('.history-row--current')).toBeNull();
  });

  it('штамп абсолютный и со временем — «40 / 41 мин назад» ничего не расставляет', () => {
    index();
    expect(screen.getByText('13 августа, 14:22')).toBeTruthy();
    expect(screen.getByText('13 августа, 09:05')).toBeTruthy();
    expect(document.body.textContent).not.toContain('назад');
  });

  it('доступное имя строки говорит, что она открывает и что именно', () => {
    index();
    expect(screen.getByRole('button', { name: 'Открыть версию 1 из 2 от 13 августа, 09:05' })).toBeTruthy();
  });

  it('при открытии фокус уходит на первую строку, а не остаётся на body', async () => {
    // useModalA11y начальный фокус не ставит — это дело вызывающего, и без
    // него вход «из ленты» оставлял бы фокус на исчезнувшем пункте меню.
    index();
    await vi.waitFor(() => {
      expect(document.activeElement?.getAttribute('aria-label'))
        .toBe('Открыть версию 2 из 2 от 13 августа, 14:22');
    });
  });
});
