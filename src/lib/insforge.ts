import { createClient } from '@insforge/sdk';

export const insforge = createClient({
  baseUrl: import.meta.env.VITE_INSFORGE_URL as string,
  anonKey: import.meta.env.VITE_INSFORGE_ANON_KEY as string,
});
