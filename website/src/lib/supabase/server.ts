// Server-side only: uses the secret key, which bypasses row-level security. Never import from client code.
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;

let admin: SupabaseClient | undefined;

/** True when the Supabase environment is configured; without it the app runs on in-memory state. */
export const supabaseConfigured = Boolean(url && secretKey);

/** The service client (secret key). Undefined when Supabase is not configured. */
export function supabaseAdmin(): SupabaseClient | undefined {
  if (!supabaseConfigured) return undefined;
  admin ??= createClient(url!, secretKey!, { auth: { persistSession: false, autoRefreshToken: false } });
  return admin;
}

/** The signed-in user behind a request (Authorization: Bearer <access token>), if any. */
export async function userFrom(request: Request): Promise<User | undefined> {
  const client = supabaseAdmin();
  const token = request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
  if (!client || !token) return undefined;
  const { data, error } = await client.auth.getUser(token);
  return error ? undefined : data.user;
}
