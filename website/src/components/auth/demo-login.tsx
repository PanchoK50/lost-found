'use client';

import { useEffect, useState } from 'react';
import { Sheet } from '@/components/world/sheet';
import { supabaseBrowser } from '@/lib/supabase/browser';
import { saveProfile, type Profile } from '@/lib/world/profile';
import type { Role } from '@/lib/world/types';

interface DemoUser { username: string; displayName: string; role: Role }

/** The signed-in Supabase user id, or null when signed out (undefined while loading). */
export function useSignedIn(): string | null | undefined {
  const [userId, setUserId] = useState<string | null | undefined>(supabaseBrowser() ? undefined : null);
  useEffect(() => {
    const client = supabaseBrowser();
    if (!client) return;
    void client.auth.getSession().then(({ data }) => setUserId(data.session?.user.id ?? null));
    const { data } = client.auth.onAuthStateChange((_event, session) => setUserId(session?.user.id ?? null));
    return () => data.subscription.unsubscribe();
  }, []);
  return userId;
}

/** "Who are you?": pick one of the demo accounts, no sign-up. The player profile becomes that account. */
export function DemoLoginSheet({ profile, onClose }: { profile: Profile | null; onClose?: () => void }) {
  const [users, setUsers] = useState<DemoUser[]>([]);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    void fetch('/api/demo-login').then(res => res.json()).then(data => Array.isArray(data) ? setUsers(data) : setError(data.error));
  }, []);

  async function signIn(username: string) {
    setBusy(username);
    setError(undefined);
    try {
      const res = await fetch('/api/demo-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Sign-in failed.');
      const { error: sessionError } = await supabaseBrowser()!.auth.setSession(data.session);
      if (sessionError) throw sessionError;
      // The world identifies players by profile id: make it the account's id, keep local settings.
      const { id, displayName, role, groups } = data.profile;
      saveProfile({ settings: {}, rooms: {}, ...(profile ?? {}), id, name: displayName, role, groups });
      onClose?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <Sheet title="Who are you?" onClose={onClose ?? (() => undefined)}>
      <p className="sheet-hint">Pick a demo account. No sign-up needed.</p>
      <div className="demo-users">
        {users.map(user => (
          <button type="button" key={user.username} disabled={Boolean(busy)} onClick={() => void signIn(user.username)}
            aria-pressed={profile?.name === user.displayName}>
            <span className="demo-initial">{user.displayName.slice(0, 1)}</span>
            <span>{user.displayName}</span>
            <small>{busy === user.username ? 'Signing in…' : user.role === 'facility' ? 'Facility' : 'Member'}</small>
          </button>
        ))}
      </div>
      {error && <p className="sheet-error" role="alert">{error}</p>}
      {onClose && profile && (
        <button type="button" className="demo-signout" onClick={() => void supabaseBrowser()?.auth.signOut().then(onClose)}>Sign out</button>
      )}
    </Sheet>
  );
}
