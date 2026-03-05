CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- ============================================================
-- MIGRATION: Full Security Hardening & Feature Additions
-- ============================================================

-- 1. Add missing columns to transactions
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS seller_email TEXT,
  ADD COLUMN IF NOT EXISTS buyer_email TEXT,
  ADD COLUMN IF NOT EXISTS seller_phone TEXT,
  ADD COLUMN IF NOT EXISTS buyer_phone TEXT,
  ADD COLUMN IF NOT EXISTS product_released BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS product_received BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS disputed_at TIMESTAMPTZ;

-- Update status check to include 'accepted' and 'released'
ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_status_check;
ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_status_check
  CHECK (status IN ('pending_approval','approved','funded','delivered','accepted','released','disputed','cancelled','completed'));

-- 2. Disputes table (hardened) — stores disputes separately from transaction status
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

-- Only participants can see their own disputes
CREATE POLICY "Participants can view their disputes"
ON public.disputes FOR SELECT
USING (
  auth.uid() = raised_by
  OR EXISTS (
    SELECT 1 FROM public.transactions t WHERE t.id = transaction_id
    AND (auth.uid() = t.created_by OR auth.uid() = t.buyer_id OR auth.uid() = t.seller_id OR auth.uid() = t.broker_id)
  )
);

-- Only participants can open disputes
CREATE POLICY "Participants can open disputes"
ON public.disputes FOR INSERT
WITH CHECK (
  auth.uid() = raised_by
  AND EXISTS (
    SELECT 1 FROM public.transactions t WHERE t.id = transaction_id
    AND (auth.uid() = t.created_by OR auth.uid() = t.buyer_id OR auth.uid() = t.seller_id OR auth.uid() = t.broker_id)
  )
);

-- Only service_role (admin functions) can update disputes
CREATE POLICY "Service role can manage disputes"
ON public.disputes FOR UPDATE
USING (FALSE); -- no direct client updates; only edge functions via service_role

CREATE TRIGGER update_disputes_updated_at
BEFORE UPDATE ON public.disputes
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 3. OTP table for registration verification
CREATE TABLE IF NOT EXISTS public.email_otps (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT NOT NULL,
  otp TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '10 minutes'),
  used BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No RLS on this table — only accessed via service_role in edge functions
ALTER TABLE public.email_otps ENABLE ROW LEVEL SECURITY;
-- Block all direct client access
CREATE POLICY "No direct client access to OTPs" ON public.email_otps FOR ALL USING (FALSE);

-- Index for OTP lookups
CREATE INDEX IF NOT EXISTS idx_email_otps_email ON public.email_otps(email);
CREATE INDEX IF NOT EXISTS idx_email_otps_expires ON public.email_otps(expires_at);

-- 4. Remove overly permissive transaction UPDATE policy
DROP POLICY IF EXISTS "Participants can update transactions" ON public.transactions;

-- NO direct client updates to transaction status; only edge functions via service_role
CREATE POLICY "No direct status updates from client"
ON public.transactions FOR UPDATE
USING (FALSE);

-- 5. Harden escrow_holds — remove client insert policy
DROP POLICY IF EXISTS "System can insert escrow holds" ON public.escrow_holds;
DROP POLICY IF EXISTS "Users can view own escrow holds" ON public.escrow_holds;

-- Only service_role can insert/update escrow holds
CREATE POLICY "Service role only escrow insert"
ON public.escrow_holds FOR INSERT
WITH CHECK (FALSE); -- only via edge functions using service_role

-- Participants can see their escrow holds
CREATE POLICY "Participants can view escrow holds"
ON public.escrow_holds FOR SELECT
USING (
  auth.uid() = user_id
  OR EXISTS (
    SELECT 1 FROM public.transactions t WHERE t.id = transaction_id
    AND (auth.uid() = t.created_by OR auth.uid() = t.buyer_id OR auth.uid() = t.seller_id OR auth.uid() = t.broker_id)
  )
);

-- 6. Harden wallet_transactions — users cannot directly insert deposits
DROP POLICY IF EXISTS "Users can insert own wallet transactions" ON public.wallet_transactions;
-- Deposits are only inserted by daraja-callback (service_role)
-- Withdrawals are inserted by withdraw edge function (service_role)

-- 7. Update approval_token column type to TEXT (uuid col already exists but we store as text)
ALTER TABLE public.transactions ALTER COLUMN approval_token TYPE TEXT USING approval_token::TEXT;
ALTER TABLE public.transactions ALTER COLUMN approval_token SET DEFAULT encode(gen_random_bytes(32), 'hex');

-- 8. Update wallet_transactions type check to allow deposit_pending
ALTER TABLE public.wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_type_check;
ALTER TABLE public.wallet_transactions
  ADD CONSTRAINT wallet_transactions_type_check
  CHECK (type IN ('deposit', 'deposit_pending', 'withdrawal', 'escrow_hold', 'escrow_release'));

-- 9. Add phone to profiles (if not exist)
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS phone TEXT;

-- 10. Admin view: profiles visible to admin
CREATE POLICY "Admin can view all profiles"
ON public.profiles FOR SELECT
USING (
  public.has_role(auth.uid(), 'admin')
);

-- 11. Daraja callback secret for endpoint verification
-- (stored as env var DARAJA_CALLBACK_SECRET, checked in edge function)

-- 12. Add index on transactions for participant lookups
CREATE INDEX IF NOT EXISTS idx_transactions_buyer ON public.transactions(buyer_id);
CREATE INDEX IF NOT EXISTS idx_transactions_seller ON public.transactions(seller_id);
CREATE INDEX IF NOT EXISTS idx_transactions_broker ON public.transactions(broker_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created_by ON public.transactions(created_by);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON public.transactions(status);

-- 13. Grant service_role access to disputes
GRANT ALL ON public.disputes TO service_role;
GRANT ALL ON public.email_otps TO service_role;
GRANT ALL ON public.escrow_holds TO service_role;
GRANT ALL ON public.wallet_transactions TO service_role;
GRANT ALL ON public.wallets TO service_role;
GRANT ALL ON public.transactions TO service_role;

-- 14. Function: raise_dispute (server-side, validates participant)
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

  IF _tx.status IN ('released', 'cancelled', 'disputed') THEN
    RAISE EXCEPTION 'Cannot dispute a transaction with status: %', _tx.status;
  END IF;

  -- Update transaction status
  UPDATE public.transactions SET status = 'disputed', disputed_at = now() WHERE id = _transaction_id;

  -- Create dispute record
  INSERT INTO public.disputes (transaction_id, raised_by, reason)
  VALUES (_transaction_id, auth.uid(), _reason)
  RETURNING id INTO _dispute_id;

  RETURN _dispute_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.raise_dispute TO authenticated;

-- 15. Function: mark_product_released (seller only)
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

-- 16. Function: mark_product_received (buyer only)
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

-- 17. Realtime on disputes for admin dashboard
ALTER PUBLICATION supabase_realtime ADD TABLE public.disputes;
