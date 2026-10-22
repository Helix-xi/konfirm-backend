'use client';

import { useCallback, useEffect, useState } from 'react';

interface FacilitatorStatus {
  paused: boolean;
  capUsdc: number;
  spentTodayUsdc: number;
  remainingUsdc: number;
  updatedAt: string | null;
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? '';

async function adminFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
}

export default function AdminFacilitatorPage() {
  const [status, setStatus] = useState<FacilitatorStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [capInput, setCapInput] = useState('');
  const [savingCap, setSavingCap] = useState(false);
  const [resuming, setResuming] = useState(false);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminFetch('/admin/facilitator/status');
      if (!res.ok) {
        throw new Error(`Failed to load facilitator status (${res.status})`);
      }
      const data = (await res.json()) as FacilitatorStatus;
      setStatus(data);
      setCapInput(String(data.capUsdc));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load facilitator status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const handleSaveCap = async () => {
    const parsed = Number(capInput);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setError('Daily cap must be a non-negative number');
      return;
    }
    setSavingCap(true);
    setError(null);
    try {
      const res = await adminFetch('/admin/facilitator/cap', {
        method: 'PATCH',
        body: JSON.stringify({ capUsdc: parsed }),
      });
      if (!res.ok) {
        throw new Error(`Failed to update daily cap (${res.status})`);
      }
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update daily cap');
    } finally {
      setSavingCap(false);
    }
  };

  const handleResume = async () => {
    setResuming(true);
    setError(null);
    try {
      const res = await adminFetch('/admin/facilitator/resume', { method: 'POST' });
      if (!res.ok) {
        throw new Error(`Failed to resume signing (${res.status})`);
      }
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resume signing');
    } finally {
      setResuming(false);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Facilitator</h1>
        <p className="text-sm text-gray-500">
          Operational controls for the x402 facilitator signing service.
        </p>
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading && !status ? (
        <div className="text-sm text-gray-500">Loading facilitator status…</div>
      ) : status ? (
        <div className="space-y-6">
          <div className="rounded border border-gray-200 p-4">
            <h2 className="text-lg font-medium">Status</h2>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-gray-500">Signing paused</dt>
                <dd className="font-medium">{status.paused ? 'Yes' : 'No'}</dd>
              </div>
              <div>
                <dt className="text-gray-500">Spent today</dt>
                <dd className="font-medium">${status.spentTodayUsdc.toFixed(2)}</dd>
              </div>
              <div>
                <dt className="text-gray-500">Remaining today</dt>
                <dd className="font-medium">${status.remainingUsdc.toFixed(2)}</dd>
              </div>
              <div>
                <dt className="text-gray-500">Last updated</dt>
                <dd className="font-medium">
                  {status.updatedAt ? new Date(status.updatedAt).toLocaleString() : '—'}
                </dd>
              </div>
            </dl>
          </div>

          <div className="rounded border border-gray-200 p-4">
            <h2 className="text-lg font-medium">Daily spend cap</h2>
            <p className="mt-1 text-sm text-gray-500">
              Maximum USDC the facilitator may spend per day. Changes take effect immediately.
            </p>
            <div className="mt-3 flex items-end gap-3">
              <label className="flex flex-col text-sm">
                <span className="text-gray-500">Cap (USDC)</span>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={capInput}
                  onChange={(e) => setCapInput(e.target.value)}
                  className="mt-1 w-40 rounded border border-gray-300 px-3 py-2"
                />
              </label>
              <button
                type="button"
                onClick={handleSaveCap}
                disabled={savingCap || capInput === String(status.capUsdc)}
                className="rounded bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {savingCap ? 'Saving…' : 'Save cap'}
              </button>
            </div>
          </div>

          <div className="rounded border border-gray-200 p-4">
            <h2 className="text-lg font-medium">Signing</h2>
            <p className="mt-1 text-sm text-gray-500">
              Resume signing if the facilitator was paused after hitting its daily cap.
            </p>
            <button
              type="button"
              onClick={handleResume}
              disabled={resuming || !status.paused}
              className="mt-3 rounded bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {resuming ? 'Resuming…' : 'Resume signing'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
