import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!url) throw new Error('SUPABASE_URL is not set');
if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY is not set');

export const supabase = createClient(url, serviceKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
  global: {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
  },
});


