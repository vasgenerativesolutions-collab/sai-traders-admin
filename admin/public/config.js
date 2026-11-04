// Public Supabase configuration for the dashboard.
//
// Sign-in used to depend on GET /api/auth/supabase-config, which meant the Supabase
// client could not be created unless the store server was already reachable — so a
// dashboard hosted anywhere else could never log in. These two values are public by
// design (the anon key is intended for browsers and is constrained by RLS), so the
// page can authenticate on its own and reach the API afterwards.
window.SAI_SUPABASE_URL = 'https://aisttddxrbizoshtpdxi.supabase.co';
window.SAI_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFpc3R0ZGR4cmJpem9zaHRwZHhpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA1NzE1ODEsImV4cCI6MjEwNjE0NzU4MX0.zVPplpD-h_ObVxNoqcj8I_ixBGBtB0OtcJ0AHxekzZg';
