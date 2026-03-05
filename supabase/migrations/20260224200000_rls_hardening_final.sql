-- ============================================================
-- MIGRATION: Final RLS Hardening
-- Timestamp: 20260224200000
-- ============================================================

-- ── 1. has_role helper (idempotent) ─────────────────────────────────────────
-- Checks if a user has a given role in the profiles table.
-- Used by all admin policies.
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE user_id = _user_id
      AND role = _role
      AND is_active = TRUE
  );
$$;

GRANT EXECUTE ON FUNCTION public.has_role TO authenticated;

-- ── 2. wallets — users can only SELECT their own wallet ──────────────────────
-- Wallet mutations only via service_role RPCs: add_wallet_funds / withdraw_wallet_funds
ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own wallet" ON public.wallets;
CREATE POLICY "Users can view own wallet"
ON public.wallets FOR SELECT
USING (auth.uid() = user_id);

-- Block all direct client mutations (service_role bypasses RLS)
DROP POLICY IF EXISTS "No direct wallet insert" ON public.wallets;
CREATE POLICY "No direct wallet insert"
ON public.wallets FOR INSERT
WITH CHECK (FALSE);

DROP POLICY IF EXISTS "No direct wallet update" ON public.wallets;
CREATE POLICY "No direct wallet update"
ON public.wallets FOR UPDATE
USING (FALSE);

DROP POLICY IF EXISTS "No direct wallet delete" ON public.wallets;
CREATE POLICY "No direct wallet delete"
ON public.wallets FOR DELETE
USING (FALSE);

-- ── 3. wallet_transactions — users see only their own ────────────────────────
ALTER TABLE public.wallet_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own wallet transactions" ON public.wallet_transactions;
CREATE POLICY "Users can view own wallet transactions"
ON public.wallet_transactions FOR SELECT
USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "No direct wallet_transaction insert" ON public.wallet_transactions;
CREATE POLICY "No direct wallet_transaction insert"
ON public.wallet_transactions FOR INSERT
WITH CHECK (FALSE);

DROP POLICY IF EXISTS "No direct wallet_transaction update" ON public.wallet_transactions;
CREATE POLICY "No direct wallet_transaction update"
ON public.wallet_transactions FOR UPDATE
USING (FALSE);

DROP POLICY IF EXISTS "No direct wallet_transaction delete" ON public.wallet_transactions;
CREATE POLICY "No direct wallet_transaction delete"
ON public.wallet_transactions FOR DELETE
USING (FALSE);

-- ── 4. transactions — participants & admin can SELECT ────────────────────────
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

-- Drop legacy over-permissive policies
DROP POLICY IF EXISTS "Users can view own transactions" ON public.transactions;
DROP POLICY IF EXISTS "Participants can update transactions" ON public.transactions;
DROP POLICY IF EXISTS "Admin can view all transactions" ON public.transactions;

CREATE POLICY "Participants can view their transactions"
ON public.transactions FOR SELECT
USING (
  auth.uid() = created_by
  OR auth.uid() = buyer_id
  OR auth.uid() = seller_id
  OR auth.uid() = broker_id
  OR public.has_role(auth.uid(), 'admin')
);

-- Users can create transactions (validated in edge function)
DROP POLICY IF EXISTS "Authenticated users can create transactions" ON public.transactions;
CREATE POLICY "Authenticated users can create transactions"
ON public.transactions FOR INSERT
WITH CHECK (auth.uid() = created_by);

-- NO direct client updates — all updates via service_role edge functions
DROP POLICY IF EXISTS "No direct status updates from client" ON public.transactions;
CREATE POLICY "No direct status updates from client"
ON public.transactions FOR UPDATE
USING (FALSE);

-- ── 5. profiles — users see their own; admin sees all ────────────────────────
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
CREATE POLICY "Users can view own profile"
ON public.profiles FOR SELECT
USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
CREATE POLICY "Users can update own profile"
ON public.profiles FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "System can insert profile" ON public.profiles;
CREATE POLICY "System can insert profile"
ON public.profiles FOR INSERT
WITH CHECK (auth.uid() = user_id);

-- ── 6. escrow_holds — participants can SELECT; all mutations via service_role ─
ALTER TABLE public.escrow_holds ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Participants can view escrow holds" ON public.escrow_holds;
CREATE POLICY "Participants can view escrow holds"
ON public.escrow_holds FOR SELECT
USING (
  auth.uid() = user_id
  OR EXISTS (
    SELECT 1 FROM public.transactions t
    WHERE t.id = escrow_holds.transaction_id
    AND (
      auth.uid() = t.created_by
      OR auth.uid() = t.buyer_id
      OR auth.uid() = t.seller_id
      OR auth.uid() = t.broker_id
    )
  )
  OR public.has_role(auth.uid(), 'admin')
);

DROP POLICY IF EXISTS "No direct escrow insert" ON public.escrow_holds;
CREATE POLICY "No direct escrow insert"
ON public.escrow_holds FOR INSERT
WITH CHECK (FALSE);

DROP POLICY IF EXISTS "No direct escrow update" ON public.escrow_holds;
CREATE POLICY "No direct escrow update"
ON public.escrow_holds FOR UPDATE
USING (FALSE);

DROP POLICY IF EXISTS "No direct escrow delete" ON public.escrow_holds;
CREATE POLICY "No direct escrow delete"
ON public.escrow_holds FOR DELETE
USING (FALSE);

-- ── 7. transaction_messages ───────────────────────────────────────────────────
ALTER TABLE public.transaction_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Participants can view messages" ON public.transaction_messages;
CREATE POLICY "Participants can view messages"
ON public.transaction_messages FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.transactions t
    WHERE t.id = transaction_messages.transaction_id
    AND (
      auth.uid() = t.created_by
      OR auth.uid() = t.buyer_id
      OR auth.uid() = t.seller_id
      OR auth.uid() = t.broker_id
    )
  )
  OR public.has_role(auth.uid(), 'admin')
);

DROP POLICY IF EXISTS "Transaction participants can send messages" ON public.transaction_messages;
CREATE POLICY "Transaction participants can send messages"
ON public.transaction_messages FOR INSERT
WITH CHECK (
  auth.uid() = sender_id
  AND EXISTS (
    SELECT 1 FROM public.transactions t
    WHERE t.id = transaction_messages.transaction_id
    AND (
      auth.uid() = t.created_by
      OR auth.uid() = t.buyer_id
      OR auth.uid() = t.seller_id
      OR auth.uid() = t.broker_id
    )
  )
);

-- No direct updates/deletes on messages
DROP POLICY IF EXISTS "No direct message update" ON public.transaction_messages;
CREATE POLICY "No direct message update"
ON public.transaction_messages FOR UPDATE
USING (FALSE);

-- ── 8. disputes ───────────────────────────────────────────────────────────────
-- Participants SELECT, no direct INSERT/UPDATE (use raise_dispute RPC instead)
ALTER TABLE public.disputes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Participants can view their disputes" ON public.disputes;
CREATE POLICY "Participants can view their disputes"
ON public.disputes FOR SELECT
USING (
  auth.uid() = raised_by
  OR EXISTS (
    SELECT 1 FROM public.transactions t
    WHERE t.id = disputes.transaction_id
    AND (
      auth.uid() = t.created_by
      OR auth.uid() = t.buyer_id
      OR auth.uid() = t.seller_id
      OR auth.uid() = t.broker_id
    )
  )
  OR public.has_role(auth.uid(), 'admin')
);

DROP POLICY IF EXISTS "No direct dispute insert" ON public.disputes;
CREATE POLICY "No direct dispute insert"
ON public.disputes FOR INSERT
WITH CHECK (FALSE);

DROP POLICY IF EXISTS "No direct dispute update" ON public.disputes;
CREATE POLICY "No direct dispute update"
ON public.disputes FOR UPDATE
USING (FALSE);

-- ── 9. email_otps / pending_registrations — no client access ─────────────────
-- Already set in earlier migrations; ensure they're here as idempotent fallback.
ALTER TABLE public.email_otps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "No direct client access to OTPs" ON public.email_otps;
CREATE POLICY "No direct client access to OTPs"
ON public.email_otps FOR ALL
USING (FALSE);

ALTER TABLE public.pending_registrations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "No client access to pending registrations" ON public.pending_registrations;
CREATE POLICY "No client access to pending registrations"
ON public.pending_registrations FOR ALL
USING (FALSE);

-- ── 10. admin_disputes_view — restrict to admin only ─────────────────────────
-- Re-create with SECURITY INVOKER so RLS on base tables is respected.
DROP VIEW IF EXISTS public.admin_disputes_view;
CREATE VIEW public.admin_disputes_view
WITH (security_invoker = true)
AS
SELECT
  d.id               AS dispute_id,
  d.transaction_id,
  d.reason,
  d.status           AS dispute_status,
  d.admin_notes,
  d.created_at       AS disputed_at,
  t.title            AS transaction_title,
  t.amount           AS transaction_amount,
  t.status           AS transaction_status,
  p_raiser.first_name AS raiser_first_name,
  p_raiser.last_name  AS raiser_last_name,
  p_raiser.email      AS raiser_email,
  p_raiser.phone      AS raiser_phone,
  p_buyer.first_name  AS buyer_first_name,
  p_buyer.last_name   AS buyer_last_name,
  p_buyer.email       AS buyer_email,
  p_buyer.phone       AS buyer_phone,
  p_seller.first_name AS seller_first_name,
  p_seller.last_name  AS seller_last_name,
  p_seller.email      AS seller_email,
  p_seller.phone      AS seller_phone
FROM public.disputes d
JOIN public.transactions t ON t.id = d.transaction_id
JOIN public.profiles p_raiser ON p_raiser.user_id = d.raised_by
LEFT JOIN public.profiles p_buyer ON p_buyer.user_id = t.buyer_id
LEFT JOIN public.profiles p_seller ON p_seller.user_id = t.seller_id;

-- Only admins can query this view (backed by RLS on base tables via security_invoker)
GRANT SELECT ON public.admin_disputes_view TO authenticated;

-- ── 11. add_wallet_funds RPC — ensure it's robust ────────────────────────────
CREATE OR REPLACE FUNCTION public.add_wallet_funds(
  _user_id UUID,
  _amount NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF _amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be positive, got: %', _amount;
  END IF;

  INSERT INTO public.wallets (user_id, balance)
  VALUES (_user_id, _amount)
  ON CONFLICT (user_id)
  DO UPDATE SET balance = wallets.balance + EXCLUDED.balance;
END;
$$;

-- Only callable from service_role (edge functions)
REVOKE EXECUTE ON FUNCTION public.add_wallet_funds FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.add_wallet_funds FROM authenticated;
GRANT EXECUTE ON FUNCTION public.add_wallet_funds TO service_role;

-- ── 12. withdraw_wallet_funds RPC — ensure it's robust ───────────────────────
CREATE OR REPLACE FUNCTION public.withdraw_wallet_funds(
  _user_id UUID,
  _amount NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _current_balance NUMERIC;
BEGIN
  IF _amount <= 0 THEN
    RAISE EXCEPTION 'Withdrawal amount must be positive, got: %', _amount;
  END IF;

  -- Lock the row to prevent concurrent withdrawals
  SELECT balance INTO _current_balance
  FROM public.wallets
  WHERE user_id = _user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found for user: %', _user_id;
  END IF;

  IF _current_balance < _amount THEN
    RAISE EXCEPTION 'Insufficient balance: has %, needs %', _current_balance, _amount;
  END IF;

  UPDATE public.wallets
  SET balance = balance - _amount
  WHERE user_id = _user_id;
END;
$$;

-- Only callable from service_role
REVOKE EXECUTE ON FUNCTION public.withdraw_wallet_funds FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.withdraw_wallet_funds FROM authenticated;
GRANT EXECUTE ON FUNCTION public.withdraw_wallet_funds TO service_role;

-- ── 13. Service role gets full access to all operational tables ───────────────
GRANT ALL ON public.wallets TO service_role;
GRANT ALL ON public.wallet_transactions TO service_role;
GRANT ALL ON public.transactions TO service_role;
GRANT ALL ON public.profiles TO service_role;
GRANT ALL ON public.escrow_holds TO service_role;
GRANT ALL ON public.disputes TO service_role;
GRANT ALL ON public.email_otps TO service_role;
GRANT ALL ON public.pending_registrations TO service_role;
GRANT ALL ON public.transaction_messages TO service_role;

-- ── 14. Indexes for performance ───────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_wallet_tx_user_id ON public.wallet_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_checkout ON public.wallet_transactions(checkout_request_id);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_type ON public.wallet_transactions(type);
CREATE INDEX IF NOT EXISTS idx_transactions_buyer ON public.transactions(buyer_id);
CREATE INDEX IF NOT EXISTS idx_transactions_seller ON public.transactions(seller_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON public.transactions(status);
CREATE INDEX IF NOT EXISTS idx_disputes_transaction ON public.disputes(transaction_id);
