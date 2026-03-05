-- ============================================================
-- MIGRATION: Fix pending_registrations for OTP registration flow
-- Timestamp: 20260225000000
-- ============================================================

-- The password_hash column stores the user's plain password temporarily
-- between send-otp and verify-otp. It is deleted immediately after
-- verify-otp calls auth.admin.createUser() successfully.
-- Column is TEXT (not a hash) because Supabase's createUser API
-- accepts the raw password and handles hashing internally.

-- Ensure the column exists and has no length constraint
ALTER TABLE public.pending_registrations
  ALTER COLUMN password_hash TYPE TEXT;

-- Ensure the table is only accessible via service_role (never by clients)
ALTER TABLE public.pending_registrations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "No client access to pending registrations" ON public.pending_registrations;
CREATE POLICY "No client access to pending registrations"
  ON public.pending_registrations
  FOR ALL
  USING (FALSE);

GRANT ALL ON public.pending_registrations TO service_role;

-- Auto-cleanup: delete registrations older than 30 minutes (OTP is 10 min,
-- so 30 min is a generous safety window)
CREATE OR REPLACE FUNCTION public.cleanup_stale_pending_registrations()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _deleted INTEGER;
BEGIN
  DELETE FROM public.pending_registrations
  WHERE otp_expires_at < now() - INTERVAL '20 minutes';
  GET DIAGNOSTICS _deleted = ROW_COUNT;
  RETURN _deleted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cleanup_stale_pending_registrations TO service_role;

-- Also ensure email_otps cleans up properly
CREATE INDEX IF NOT EXISTS idx_pending_reg_otp_expires
  ON public.pending_registrations(otp_expires_at);
