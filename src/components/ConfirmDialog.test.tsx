// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ConfirmDialog } from './ConfirmDialog';

afterEach(cleanup);

function renderDialog(overrides: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmDialog
      open
      title="Сбросить приложение?"
      message="Все данные будут удалены."
      confirmLabel="Удалить всё"
      danger
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { onConfirm, onCancel };
}

describe('ConfirmDialog', () => {
  it('renders nothing when closed', () => {
    renderDialog({ open: false });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders title/message and fires onConfirm from the danger button', () => {
    const { onConfirm, onCancel } = renderDialog();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Все данные будут удалены.')).toBeTruthy();
    fireEvent.click(screen.getByText('Удалить всё'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('Escape cancels', () => {
    const { onConfirm, onCancel } = renderDialog();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('backdrop click cancels, click inside the dialog does not', () => {
    const { onCancel } = renderDialog();
    fireEvent.click(screen.getByText('Все данные будут удалены.'));
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector('.confirm-overlay')!);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('initial focus lands on the SAFE (cancel) button', () => {
    renderDialog();
    expect(document.activeElement?.textContent).toBe('Отмена');
  });

  it('traps Tab inside the dialog (wraps last → first and first → last)', () => {
    renderDialog();
    // Focus starts on «Отмена» (first); the confirm button is last.
    screen.getByText('Удалить всё').focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement?.textContent).toBe('Отмена'); // wrapped forward

    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement?.textContent).toBe('Удалить всё'); // wrapped back
  });

  it('returns focus to the previously-focused element on close', () => {
    const outside = document.createElement('button');
    outside.textContent = 'trigger';
    document.body.appendChild(outside);
    outside.focus();

    const onCancel = vi.fn();
    const { rerender } = render(
      <ConfirmDialog open title="t" message="m" onConfirm={vi.fn()} onCancel={onCancel} />,
    );
    expect(document.activeElement?.textContent).toBe('Отмена');

    rerender(<ConfirmDialog open={false} title="t" message="m" onConfirm={vi.fn()} onCancel={onCancel} />);
    expect(document.activeElement).toBe(outside); // focus returned
    outside.remove();
  });
});
