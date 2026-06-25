import { useCallback, useEffect, useRef, useState } from 'react';

export type AppRecoveryReason = 'startup' | 'auth-change' | 'focus' | 'visible' | 'online' | 'manual';

interface UseAppRecoveryOptions {
  enabled: boolean;
  triggerKey: string;
  refresh: (reason: AppRecoveryReason) => Promise<void>;
  minIntervalMs?: number;
}

const RETRY_DELAYS_MS = [0, 2000, 5000];

export function useAppRecovery({
  enabled,
  triggerKey,
  refresh,
  minIntervalMs = 4000,
}: UseAppRecoveryOptions) {
  const [isRecovering, setIsRecovering] = useState(false);
  const [lastRecoveryAt, setLastRecoveryAt] = useState<number | null>(null);
  const [lastRecoveryError, setLastRecoveryError] = useState<string | null>(null);
  const refreshRef = useRef(refresh);
  const lastRunAtRef = useRef(0);
  const runningRef = useRef(false);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  const refreshNow = useCallback(async (
    reason: AppRecoveryReason = 'manual',
    options?: { force?: boolean },
  ) => {
    if (!enabled || runningRef.current) return;
    const now = Date.now();
    if (!options?.force && now - lastRunAtRef.current < minIntervalMs) return;

    runningRef.current = true;
    lastRunAtRef.current = now;
    setIsRecovering(true);
    setLastRecoveryError(null);

    try {
      let lastError: unknown = null;
      for (let i = 0; i < RETRY_DELAYS_MS.length; i += 1) {
        const delay = RETRY_DELAYS_MS[i];
        if (delay > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, delay));
        }
        try {
          await refreshRef.current(reason);
          setLastRecoveryAt(Date.now());
          return;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    } catch (error: any) {
      setLastRecoveryError(error?.message || '页面数据刷新失败');
    } finally {
      runningRef.current = false;
      setIsRecovering(false);
    }
  }, [enabled, minIntervalMs]);

  useEffect(() => {
    if (!enabled) return;
    void refreshNow('startup', { force: true });
  }, [enabled, triggerKey, refreshNow]);

  useEffect(() => {
    if (!enabled) return;

    const handleFocus = () => {
      if (document.hidden) return;
      void refreshNow('focus');
    };

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        void refreshNow('visible');
      }
    };

    const handleOnline = () => {
      void refreshNow('online', { force: true });
    };

    window.addEventListener('focus', handleFocus);
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [enabled, refreshNow]);

  return {
    isRecovering,
    lastRecoveryAt,
    lastRecoveryError,
    refreshNow,
  };
}
