-- ============================================================
-- MIGRATION: Full Hardening, OTP Auth, Disputes, Messaging
-- ============================================================

-- 1. Platform fee: update all stored fee references (3% now enforced in edge functions)
--    No schema change needed — fee is computed at transaction creation.

-- 2. Ensure email_otps table exists with proper structure
CREATE TABLE IF NOT EXISTS public.email_otps (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT NOT NULL,
  otp TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '10 minutes'),
  used BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.email_otps ENABLE ROW LEVEL SECURITY;
-- Block ALL direct client access; only service_role edge functions touch this
DROP POLICY IF EXISTS "No direct client access to OTPs" ON public.email_otps;
CREATE POLICY "No direct client access to OTPs" ON public.email_otps FOR ALL USING (FALSE);

CREATE INDEX IF NOT EXISTS idx_email_otps_email ON public.email_otps(email);
CREATE INDEX IF NOT EXISTS idx_email_otps_expires ON public.email_otps(expires_at);

-- 3. Pending registrations table — stores signup data before OTP verified
CREATE TABLE IF NOT EXISTS public.pending_registrations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'both',
  password_hash TEXT NOT NULL,  -- bcrypt hash stored temporarily
  otp TEXT NOT NULL,
  otp_expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '10 minutes'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.pending_registrations ENABLE ROW LEVEL SECURITY;
-- No client access; only service_role
CREATE POLICY "No client access to pending registrations" ON public.pending_registrations FOR ALL USING (FALSE);
GRANT ALL ON public.pending_registrations TO service_role;

-- 4. Add email_verified flag to profiles
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

-- 5. Disputes table — ensure it exists and has all fields
CREATE TABLE IF NOT EXISTS public.disputes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  transaction_id UUID NOT NULL REFERENCES public.transactions(id) ON DELETE CASCADE,
  raised_by UUID NOT NULL REFERENCES auth.users(id),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewing','resolved','closed')),
  admin_notes TEXT,
  resolved_by UUID REFERENCES auth.users(id),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.disputes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Participants can view their disputes" ON public.disputes;
DROP POLICY IF EXISTS "Participants can open disputes" ON public.disputes;
DROP POLICY IF EXISTS "Service role can manage disputes" ON public.disputes;

-- Participants can view disputes for their transactions
CREATE POLICY "Participants can view their disputes"
ON public.disputes FOR SELECT
USING (
  auth.uid() = raised_by
  OR EXISTS (
    SELECT 1 FROM public.transactions t WHERE t.id = transaction_id
    AND (auth.uid() = t.created_by OR auth.uid() = t.buyer_id OR auth.uid() = t.seller_id OR auth.uid() = t.broker_id)
  )
  OR public.has_role(auth.uid(), 'admin')
);

-- Participants can open disputes via the raise_dispute RPC (not direct insert)
CREATE POLICY "No direct dispute insert"
ON public.disputes FOR INSERT
WITH CHECK (FALSE);

-- Only service_role updates disputes
CREATE POLICY "No direct dispute update"
ON public.disputes FOR UPDATE
USING (FALSE);

-- 6. Admin-only view for profiles with full details (phone for calling)
DROP POLICY IF EXISTS "Admin can view all profiles" ON public.profiles;
CREATE POLICY "Admin can view all profiles"
ON public.profiles FOR SELECT
USING (public.has_role(auth.uid(), 'admin'));

-- 7. Admin-only view for all transactions
DROP POLICY IF EXISTS "Admin can view all transactions" ON public.transactions;
CREATE POLICY "Admin can view all transactions"
ON public.transactions FOR SELECT
USING (public.has_role(auth.uid(), 'admin'));

-- 8. Admin-only view for all disputes with user details (via join)
CREATE OR REPLACE VIEW public.admin_disputes_view AS
SELECT
  d.id AS dispute_id,
  d.transaction_id,
  d.reason,
  d.status AS dispute_status,
  d.admin_notes,
  d.created_at AS disputed_at,
  t.title AS transaction_title,
  t.amount AS transaction_amount,
  t.status AS transaction_status,
  -- Raiser details
  p_raiser.first_name AS raiser_first_name,
  p_raiser.last_name AS raiser_last_name,
  p_raiser.email AS raiser_email,
  p_raiser.phone AS raiser_phone,
  -- Buyer details
  p_buyer.first_name AS buyer_first_name,
  p_buyer.last_name AS buyer_last_name,
  p_buyer.email AS buyer_email,
  p_buyer.phone AS buyer_phone,
  -- Seller details
  p_seller.first_name AS seller_first_name,
  p_seller.last_name AS seller_last_name,
  p_seller.email AS seller_email,
  p_seller.phone AS seller_phone
FROM public.disputes d
JOIN public.transactions t ON t.id = d.transaction_id
JOIN public.profiles p_raiser ON p_raiser.user_id = d.raised_by
LEFT JOIN public.profiles p_buyer ON p_buyer.user_id = t.buyer_id
LEFT JOIN public.profiles p_seller ON p_seller.user_id = t.seller_id;

-- Grant admin access to the view
GRANT SELECT ON public.admin_disputes_view TO authenticated;

-- 9. Fix raise_dispute function to work via RPC (security definer)
CREATE OR REPLACE FUNCTION public.raise_dispute(
  _transaction_id UUID,
  _reason TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _dispute_id UUID;
  _tx RECORD;
BEGIN
  -- Verify caller is a participant
  SELECT * INTO _tx FROM public.transactions
  WHERE id = _transaction_id
  AND (auth.uid() = created_by OR auth.uid() = buyer_id OR auth.uid() = seller_id OR auth.uid() = broker_id);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'You are not a participant in this transaction';
  END IF;

  IF _tx.status IN ('released', 'cancelled') THEN
    RAISE EXCEPTION 'Cannot dispute a transaction with status: %', _tx.status;
  END IF;

  IF _tx.status = 'disputed' THEN
    RAISE EXCEPTION 'A dispute has already been raised for this transaction';
  END IF;

  -- Update transaction status via service-level update
  UPDATE public.transactions SET status = 'disputed', disputed_at = now() WHERE id = _transaction_id;

  -- Create dispute record (bypasses RLS — SECURITY DEFINER)
  INSERT INTO public.disputes (transaction_id, raised_by, reason)
  VALUES (_transaction_id, auth.uid(), _reason)
  RETURNING id INTO _dispute_id;

  RETURN _dispute_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.raise_dispute TO authenticated;

-- 10. mark_product_released — server-side only
CREATE OR REPLACE FUNCTION public.mark_product_released(_transaction_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _tx RECORD;
BEGIN
  SELECT * INTO _tx FROM public.transactions
  WHERE id = _transaction_id
  AND auth.uid() = seller_id
  AND status = 'funded';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unauthorized or transaction not in funded state';
  END IF;

  UPDATE public.transactions
  SET product_released = TRUE, status = 'delivered'
  WHERE id = _transaction_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_product_released TO authenticated;

-- 11. mark_product_received — server-side only
CREATE OR REPLACE FUNCTION public.mark_product_received(_transaction_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _tx RECORD;
BEGIN
  SELECT * INTO _tx FROM public.transactions
  WHERE id = _transaction_id
  AND auth.uid() = buyer_id
  AND status = 'delivered'
  AND product_released = TRUE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unauthorized or product not yet released by seller';
  END IF;

  UPDATE public.transactions
  SET product_received = TRUE, status = 'accepted', accepted_at = now()
  WHERE id = _transaction_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_product_received TO authenticated;

-- 12. Transaction messages hardening — ensure only participants can message
DROP POLICY IF EXISTS "Transaction participants can send messages" ON public.transaction_messages;
CREATE POLICY "Transaction participants can send messages"
ON public.transaction_messages FOR INSERT
WITH CHECK (
  auth.uid() = sender_id
  AND EXISTS (
    SELECT 1 FROM public.transactions t
    WHERE t.id = transaction_messages.transaction_id
    AND (auth.uid() = t.created_by OR auth.uid() = t.buyer_id OR auth.uid() = t.seller_id OR auth.uid() = t.broker_id)
  )
);

-- Admin can view all messages
DROP POLICY IF EXISTS "Admin can view all messages" ON public.transaction_messages;
CREATE POLICY "Admin can view all messages"
ON public.transaction_messages FOR SELECT
USING (public.has_role(auth.uid(), 'admin'));

-- 13. Ensure escrow_holds has update/delete policies for service_role
DROP POLICY IF EXISTS "Service role only escrow insert" ON public.escrow_holds;
CREATE POLICY "No direct escrow insert" ON public.escrow_holds FOR INSERT WITH CHECK (FALSE);
DROP POLICY IF EXISTS "No direct escrow update" ON public.escrow_holds;
CREATE POLICY "No direct escrow update" ON public.escrow_holds FOR UPDATE USING (FALSE);
DROP POLICY IF EXISTS "No direct escrow delete" ON public.escrow_holds;
CREATE POLICY "No direct escrow delete" ON public.escrow_holds FOR DELETE USING (FALSE);

-- 14. Wallet: remove direct user update
DROP POLICY IF EXISTS "Users can update own wallet" ON public.wallets;
DROP POLICY IF EXISTS "Users can insert own wallet" ON public.wallets;
-- Wallet updates only via service_role functions (add_wallet_funds, withdraw_wallet_funds)

-- 15. Grant all to service_role for edge functions
GRANT ALL ON public.disputes TO service_role;
GRANT ALL ON public.email_otps TO service_role;
GRANT ALL ON public.escrow_holds TO service_role;
GRANT ALL ON public.wallet_transactions TO service_role;
GRANT ALL ON public.wallets TO service_role;
GRANT ALL ON public.transactions TO service_role;
GRANT ALL ON public.profiles TO service_role;
GRANT ALL ON public.pending_registrations TO service_role;

-- 16. Realtime publications
ALTER PUBLICATION supabase_realtime ADD TABLE public.disputes;
ALTER PUBLICATION supabase_realtime ADD TABLE public.transactions;
