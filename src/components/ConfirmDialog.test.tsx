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
});
