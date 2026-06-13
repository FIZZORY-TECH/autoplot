/**
 * src/panels/__tests__/AlpacaCredentialsModal.test.tsx
 *
 * Covers:
 *   1. Empty submit is blocked (Save button disabled when fields are empty).
 *   2. Partial empty (key only, secret empty) → still blocked.
 *   3. Successful save calls invoke('set_provider_credentials', ...) with the right args.
 *   4. After save + successful reload, onSaved callback is called.
 *   5. Cancel button calls onClose.
 *   6. Esc key calls onClose.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mock Tauri invoke — must be registered before importing the component.
// ---------------------------------------------------------------------------
const invokeMock = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

// Stub equityCredStatus so setEquityCredFailed is a no-op in tests.
vi.mock('../../data/equityCredStatus', () => ({
  setEquityCredFailed: vi.fn(),
  setEquityConnected: vi.fn(),
  subscribeEquityCredStatus: vi.fn(() => () => {}),
  isEquityCredFailed: vi.fn(() => true),
  getEquityCredStatus: vi.fn(() => ({
    failed: true,
    reason: 'no_credentials',
    connectedAt: 0,
  })),
}));

import { AlpacaCredentialsModal } from '../AlpacaCredentialsModal';

describe('AlpacaCredentialsModal', () => {
  const onClose = vi.fn();
  const onSaved = vi.fn();

  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    /**
     * Default mocks: all three commands succeed. The probe returns a
     * realistic `{ok: true, …}` so the happy-path tail (reload → connected
     * → dismiss) runs end-to-end.
     */
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'probe_alpaca_credentials') {
        return Promise.resolve({
          ok: true,
          sample_close: 178.42,
          sample_symbol: 'AAPL',
          fetched_at: '2026-05-24T01:00:00Z',
          latency_ms: 312,
        });
      }
      return Promise.resolve(undefined);
    });
  });

  function renderModal(open = true) {
    return render(
      <AlpacaCredentialsModal open={open} onClose={onClose} onSaved={onSaved} />,
    );
  }

  // -------------------------------------------------------------------------
  // 1. Empty submit is blocked
  // -------------------------------------------------------------------------
  it('Save button is disabled when both fields are empty', () => {
    renderModal();
    const save = screen.getByTestId('alpaca-creds-save');
    expect(save).toBeDisabled();
  });

  // -------------------------------------------------------------------------
  // 2. Partial empty (only key filled) → still blocked
  // -------------------------------------------------------------------------
  it('Save button is disabled when only Key ID is filled', () => {
    renderModal();
    fireEvent.change(screen.getByTestId('alpaca-creds-key-id'), {
      target: { value: 'PK_ABC123' },
    });
    const save = screen.getByTestId('alpaca-creds-save');
    expect(save).toBeDisabled();
  });

  it('Save button is disabled when only Secret is filled', () => {
    renderModal();
    fireEvent.change(screen.getByTestId('alpaca-creds-secret'), {
      target: { value: 'SK_SECRET' },
    });
    const save = screen.getByTestId('alpaca-creds-save');
    expect(save).toBeDisabled();
  });

  // -------------------------------------------------------------------------
  // 3. Successful save calls set_provider_credentials with the right args
  // -------------------------------------------------------------------------
  it('calls invoke(set_provider_credentials) with trimmed key and secret on save', async () => {
    renderModal();
    fireEvent.change(screen.getByTestId('alpaca-creds-key-id'), {
      target: { value: '  PK_TESTKEY  ' },
    });
    fireEvent.change(screen.getByTestId('alpaca-creds-secret'), {
      target: { value: '  SK_TESTSECRET  ' },
    });

    const save = screen.getByTestId('alpaca-creds-save');
    expect(save).not.toBeDisabled();
    fireEvent.click(save);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('set_provider_credentials', {
        provider: 'alpaca',
        keyId: 'PK_TESTKEY',
        secret: 'SK_TESTSECRET',
      });
    });
  });

  // -------------------------------------------------------------------------
  // 4. After successful save + reload, onSaved is called and modal closes
  // -------------------------------------------------------------------------
  it('calls onSaved and onClose after successful save + reload', async () => {
    invokeMock.mockResolvedValue(undefined); // both commands succeed
    renderModal();

    fireEvent.change(screen.getByTestId('alpaca-creds-key-id'), {
      target: { value: 'PK_KEY' },
    });
    fireEvent.change(screen.getByTestId('alpaca-creds-secret'), {
      target: { value: 'SK_SEC' },
    });
    fireEvent.click(screen.getByTestId('alpaca-creds-save'));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
      expect(onSaved).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 5. Cancel button calls onClose
  // -------------------------------------------------------------------------
  it('Cancel button calls onClose', () => {
    renderModal();
    fireEvent.click(screen.getByTestId('alpaca-creds-cancel'));
    expect(onClose).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 6. Esc key calls onClose
  // -------------------------------------------------------------------------
  it('Esc key calls onClose', () => {
    renderModal();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 7. Does not render when open=false
  // -------------------------------------------------------------------------
  it('does not render when open=false', () => {
    renderModal(false);
    expect(screen.queryByTestId('alpaca-creds-modal')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 8. Branch 1 — file-write (recoverable) shows Try again.
  // -------------------------------------------------------------------------
  it('shows a Try again button when the credential file write fails', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'set_provider_credentials') {
        return Promise.reject(
          new Error('credential write error (key_id): permission denied'),
        );
      }
      return Promise.resolve(undefined);
    });
    renderModal();
    fireEvent.change(screen.getByTestId('alpaca-creds-key-id'), {
      target: { value: 'PK_Y' },
    });
    fireEvent.change(screen.getByTestId('alpaca-creds-secret'), {
      target: { value: 'SK_Y' },
    });
    fireEvent.click(screen.getByTestId('alpaca-creds-save'));

    await waitFor(() => {
      const err = screen.getByTestId('alpaca-creds-error');
      expect(err.getAttribute('data-error-kind')).toBe('file-write');
    });
    expect(screen.getByTestId('alpaca-creds-retry')).toBeTruthy();
    expect(
      screen.getByTestId('alpaca-creds-error-detail').textContent,
    ).toMatch(/permission denied/);
  });

  // -------------------------------------------------------------------------
  // 9. Branch 2 — reload-missing — credentials saved but reload failed.
  //     Modal stays open and offers a "Reload provider" button.
  // -------------------------------------------------------------------------
  it('shows reload-only retry when save succeeded but reload failed', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'set_provider_credentials') return Promise.resolve(undefined);
      if (cmd === 'probe_alpaca_credentials') {
        return Promise.resolve({
          ok: true,
          sample_close: 178.42,
          sample_symbol: 'AAPL',
          fetched_at: '2026-05-24T01:00:00Z',
          latency_ms: 312,
        });
      }
      if (cmd === 'reload_provider') {
        return Promise.reject(
          new Error(
            'alpaca: credentials missing after save (registry lock poisoned?)',
          ),
        );
      }
      return Promise.resolve(undefined);
    });
    renderModal();
    fireEvent.change(screen.getByTestId('alpaca-creds-key-id'), {
      target: { value: 'PK_Z' },
    });
    fireEvent.change(screen.getByTestId('alpaca-creds-secret'), {
      target: { value: 'SK_Z' },
    });
    fireEvent.click(screen.getByTestId('alpaca-creds-save'));

    await waitFor(() => {
      const err = screen.getByTestId('alpaca-creds-error');
      expect(err.getAttribute('data-error-kind')).toBe('reload-missing');
    });
    expect(screen.getByTestId('alpaca-creds-reload-retry')).toBeTruthy();
    // Modal must not dismiss — onSaved/onClose stay un-called for this branch.
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 10. Probe branch: auth — Alpaca rejected the keys.
  //     Form must show the "Alpaca rejected these keys" copy and an
  //     "Edit keys" recovery button that, when clicked, returns the modal
  //     to the editable idle state and focuses the Key ID field.
  // -------------------------------------------------------------------------
  it('shows the auth error and Edit-keys path when the probe returns auth', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'probe_alpaca_credentials') {
        return Promise.resolve({
          ok: false,
          kind: 'auth',
          message: 'unauthorized',
          http_status: 401,
        });
      }
      return Promise.resolve(undefined);
    });
    renderModal();
    fireEvent.change(screen.getByTestId('alpaca-creds-key-id'), {
      target: { value: 'PK_BAD' },
    });
    fireEvent.change(screen.getByTestId('alpaca-creds-secret'), {
      target: { value: 'SK_BAD' },
    });
    fireEvent.click(screen.getByTestId('alpaca-creds-save'));

    await waitFor(() => {
      const err = screen.getByTestId('alpaca-creds-error');
      expect(err.getAttribute('data-error-kind')).toBe('auth');
      expect(
        screen.getByTestId('alpaca-creds-error-title').textContent,
      ).toMatch(/rejected/i);
    });
    const editBtn = screen.getByTestId('alpaca-creds-edit-keys');
    expect(editBtn).toBeTruthy();
    fireEvent.click(editBtn);
    // After Edit keys, the error card is gone and inputs are editable again.
    await waitFor(() => {
      expect(screen.queryByTestId('alpaca-creds-error')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 11. Probe branch: no_market_data — account valid but no entitlement.
  //     Renders the "Open Alpaca dashboard" CTA + an "I've enabled it · Retry"
  //     link that re-runs ONLY the probe.
  // -------------------------------------------------------------------------
  it('shows the dashboard CTA when the probe returns no_market_data', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'probe_alpaca_credentials') {
        return Promise.resolve({
          ok: false,
          kind: 'no_market_data',
          message: 'subscription does not permit querying market data',
          http_status: 403,
        });
      }
      return Promise.resolve(undefined);
    });
    renderModal();
    fireEvent.change(screen.getByTestId('alpaca-creds-key-id'), {
      target: { value: 'PK_OK' },
    });
    fireEvent.change(screen.getByTestId('alpaca-creds-secret'), {
      target: { value: 'SK_OK' },
    });
    fireEvent.click(screen.getByTestId('alpaca-creds-save'));

    await waitFor(() => {
      const err = screen.getByTestId('alpaca-creds-error');
      expect(err.getAttribute('data-error-kind')).toBe('no_market_data');
    });
    expect(screen.getByTestId('alpaca-creds-open-dashboard')).toBeTruthy();
    expect(screen.getByTestId('alpaca-creds-probe-retry')).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // 12. Probe branch: network — connection failed. Retry re-fires ONLY the
  //     probe (not the save).
  // -------------------------------------------------------------------------
  it('shows Retry that re-fires the probe (not save) on network failure', async () => {
    let probeCalls = 0;
    let saveCalls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'set_provider_credentials') {
        saveCalls += 1;
        return Promise.resolve(undefined);
      }
      if (cmd === 'probe_alpaca_credentials') {
        probeCalls += 1;
        return Promise.resolve({
          ok: false,
          kind: 'network',
          message: 'connect timed out',
        });
      }
      return Promise.resolve(undefined);
    });
    renderModal();
    fireEvent.change(screen.getByTestId('alpaca-creds-key-id'), {
      target: { value: 'PK_NET' },
    });
    fireEvent.change(screen.getByTestId('alpaca-creds-secret'), {
      target: { value: 'SK_NET' },
    });
    fireEvent.click(screen.getByTestId('alpaca-creds-save'));

    await waitFor(() => {
      expect(screen.getByTestId('alpaca-creds-error').getAttribute('data-error-kind')).toBe(
        'network',
      );
    });
    expect(saveCalls).toBe(1);
    expect(probeCalls).toBe(1);

    const retry = screen.getByTestId('alpaca-creds-network-retry');
    fireEvent.click(retry);
    await waitFor(() => {
      expect(probeCalls).toBe(2);
    });
    // Save must NOT be re-issued — keys are already saved locally.
    expect(saveCalls).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 13. Probe branch: unknown — falls into the existing "Try again" path,
  //     which re-fires BOTH save and probe.
  // -------------------------------------------------------------------------
  it('shows Try again that re-fires save+probe on unknown probe failure', async () => {
    let probeCalls = 0;
    let saveCalls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'set_provider_credentials') {
        saveCalls += 1;
        return Promise.resolve(undefined);
      }
      if (cmd === 'probe_alpaca_credentials') {
        probeCalls += 1;
        return Promise.resolve({
          ok: false,
          kind: 'unknown',
          message: 'unexpected 500',
          http_status: 500,
        });
      }
      return Promise.resolve(undefined);
    });
    renderModal();
    fireEvent.change(screen.getByTestId('alpaca-creds-key-id'), {
      target: { value: 'PK_UNK' },
    });
    fireEvent.change(screen.getByTestId('alpaca-creds-secret'), {
      target: { value: 'SK_UNK' },
    });
    fireEvent.click(screen.getByTestId('alpaca-creds-save'));

    await waitFor(() => {
      expect(
        screen.getByTestId('alpaca-creds-error').getAttribute('data-error-kind'),
      ).toBe('unknown');
    });
    expect(saveCalls).toBe(1);
    expect(probeCalls).toBe(1);

    fireEvent.click(screen.getByTestId('alpaca-creds-retry'));
    await waitFor(() => {
      expect(probeCalls).toBe(2);
    });
    expect(saveCalls).toBe(2);
  });
});
