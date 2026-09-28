import type { SupabaseClientOptions } from '@supabase/supabase-js';
import ws from 'ws';

/**
 * supabase-js always constructs a Realtime client, which needs a WebSocket constructor. Node 20 has no
 * native one, so the backend supplies `ws` explicitly. The backend never opens a Realtime channel.
 */
export const serverClientOptions: SupabaseClientOptions<'public'> = {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: ws as unknown as NonNullable<SupabaseClientOptions<'public'>['realtime']>['transport'] },
};
