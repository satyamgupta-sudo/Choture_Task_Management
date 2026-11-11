// Supabase schema types are kept intentionally light; regenerate with `supabase gen types typescript` for your project.
export type Database = { public: { Tables: Record<string, { Row: Record<string, unknown>; Insert: Record<string, unknown>; Update: Record<string, unknown> }>; Functions: Record<string, { Args: Record<string, unknown>; Returns: unknown }> } }
