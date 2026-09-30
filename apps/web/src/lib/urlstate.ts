"use client";
import { useCallback, useState } from "react";

/**
 * Стан вкладки/фільтрів у query-рядку (history.replaceState, без навігації). Джерело правди — актуальний `location.search`,
 * тож кілька компонентів із цим хуком не затирають параметри один одного. Лише для клієнтських компонентів, що
 * монтуються після завантаження даних (не в SSR).
 */
export function useUrlParams(): [URLSearchParams, (patch: Record<string, string | null>) => void] {
  const [params, setParams] = useState<URLSearchParams>(() => (typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search)));
  const update = useCallback((patch: Record<string, string | null>) => {
    const next = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    const qs = next.toString();
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`);
    setParams(next);
  }, []);
  return [params, update];
}
