-- Create app_settings table for dynamic secrets and live configurations
CREATE TABLE IF NOT EXISTS public.app_settings (
    key text PRIMARY KEY,
    value text NOT NULL,
    description text,
    updated_at timestamptz DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE tablename = 'app_settings' AND policyname = 'Service role full access on app_settings'
    ) THEN
        CREATE POLICY "Service role full access on app_settings"
            ON public.app_settings
            FOR ALL
            TO service_role
            USING (true)
            WITH CHECK (true);
    END IF;
END $$;

-- Allow read access
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE tablename = 'app_settings' AND policyname = 'Allow read on app_settings'
    ) THEN
        CREATE POLICY "Allow read on app_settings"
            ON public.app_settings
            FOR SELECT
            TO anon, authenticated
            USING (true);
    END IF;
END $$;
