import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/**
 * Browser Supabase client — anon key only, protected by RLS. Used for Auth sessions and
 * Realtime subscriptions. Business operations go through the Express backend.
 * `null` until VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set.
 */
export const supabase: SupabaseClient | null = url && anonKey ? createClient(url, anonKey) : null;
