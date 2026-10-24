'use client';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

let client: SupabaseClient | undefined;

/** The browser client (publishable key; the session lives in localStorage). Undefined without configuration. */
export function supabaseBrowser(): SupabaseClient | undefined {
  if (!url || !publishableKey) return undefined;
  client ??= createClient(url, publishableKey);
  return client;
}

/** Authorization header for our API routes, so they know who is asking. */
export async function authHeader(): Promise<Record<string, string>> {
  const session = (await supabaseBrowser()?.auth.getSession())?.data.session;
  return session ? { Authorization: `Bearer ${session.access_token}` } : {};
}
