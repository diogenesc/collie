import { useCallback, useEffect, useState } from "react";

import { getNotifyPrefs, setNotifyPrefs, type NotifyPrefs } from "@/lib/api";

// Settings-page controller for the bridge-wide notification-type prefs (which agent statuses push).
// Loads once on mount; a toggle is optimistic — flip the switch immediately, POST the single-key
// partial, and revert on failure — so it feels instant. These prefs live on the bridge and fan out
// to every device (like the snooze), so there's nothing per-device to persist locally.
export function useNotifyPrefs() {
  const [prefs, setPrefs] = useState<NotifyPrefs | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    getNotifyPrefs()
      .then((p) => alive && setPrefs(p))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const toggle = useCallback(async (key: keyof NotifyPrefs, next: boolean) => {
    setPrefs((prev) => (prev ? { ...prev, [key]: next } : prev)); // optimistic
    setBusy(true);
    try {
      const updated = await setNotifyPrefs({ [key]: next });
      setPrefs(updated); // reconcile with the server's merged view
    } catch {
      setPrefs((prev) => (prev ? { ...prev, [key]: !next } : prev)); // revert on failure
    } finally {
      setBusy(false);
    }
  }, []);

  return { prefs, busy, toggle };
}
