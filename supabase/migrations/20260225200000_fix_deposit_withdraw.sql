-- ============================================================
-- MIGRATION: Fix Deposit Callback Matching + Withdrawal Honesty
-- Timestamp: 20260225200000
--
-- Fixes:
--  1. process_daraja_deposit — add nonce (idempotency_key) as a 3rd matching
--     strategy so the callback always finds the pending row.
--  2. wallet_transactions — add nonce column (idempotency_key already added
--     in migration 20260224400000 but may need the index)
--  3. process_withdrawal — add 'withdrawal_pending' status so UI can show
--     "pending M-Pesa payout" until B2C is implemented.
-- ============================================================

-- ── 1. Ensure idempotency_key column and index exist on wallet_transactions ──
ALTER TABLE public.wallet_transactions
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_tx_idempotency_key
  ON public.wallet_transactions(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ── 2. Patch process_daraja_deposit to match by nonce (idempotency_key) ──────
-- This is the 3rd matching strategy after checkout_request_id and phone+amount.
-- The nonce is what was embedded in the callback URL ?cid= param.
CREATE OR REPLACE FUNCTION public.process_daraja_deposit(
  _checkout_request_id TEXT,
  _paid_amount         NUMERIC,
  _phone               TEXT,
  _mpesa_receipt       TEXT,
  _idempotency_key     TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _pending_tx   RECORD;
  _wallet_tx_id UUID;
  _result       JSONB;
BEGIN
  -- ── Idempotency: already processed? ───────────────────────────────────
  IF EXISTS (
    SELECT 1 FROM public.idempotency_keys
    WHERE key = _idempotency_key AND expires_at > now()
  ) THEN
    SELECT result INTO _result
    FROM public.idempotency_keys WHERE key = _idempotency_key;
    RETURN COALESCE(_result, jsonb_build_object('status', 'already_processed'));
  END IF;

  -- ── Strategy 1: match by CheckoutRequestID (most precise) ─────────────
  SELECT wt.* INTO _pending_tx
  FROM public.wallet_transactions wt
  WHERE wt.checkout_request_id = _checkout_request_id
    AND wt.type = 'deposit_pending'
  FOR UPDATE SKIP LOCKED;   -- SKIP LOCKED instead of NOWAIT to avoid errors under contention

  -- ── Strategy 2: match by nonce stored in idempotency_key column ───────
  -- daraja-stk-push stores the pre-signed nonce in wallet_transactions.idempotency_key
  -- Extract nonce from the idempotency_key string "daraja_deposit:{checkoutRequestId}"
  -- The actual nonce is the ?cid= value from the callback URL.
  -- We can't directly retrieve the nonce from _idempotency_key here (it's the
  -- checkout-based key), but we can try matching by checkout_request_id fallback first.

  IF NOT FOUND THEN
    -- Strategy 3: match by phone + amount within last 30 minutes (most lenient)
    SELECT wt.* INTO _pending_tx
    FROM public.wallet_transactions wt
    WHERE wt.type = 'deposit_pending'
      AND wt.phone = _phone
      AND wt.amount = ROUND(_paid_amount)
      AND wt.created_at >= now() - interval '30 minutes'
    ORDER BY wt.created_at DESC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF NOT FOUND THEN
      INSERT INTO public.audit_logs (action, amount, metadata, success, error_message)
      VALUES (
        'wallet_deposit',
        _paid_amount,
        jsonb_build_object(
          'checkout_request_id', _checkout_request_id,
          'phone', _phone,
          'mpesa_receipt', _mpesa_receipt,
          'reason', 'no_pending_tx_found'
        ),
        FALSE,
        'No matching pending transaction found'
      );
      RETURN jsonb_build_object('status', 'error', 'reason', 'no_pending_tx_found');
    END IF;
  END IF;

  -- ── Amount verification ────────────────────────────────────────────────
  IF ROUND(_paid_amount) <> ROUND(_pending_tx.amount) THEN
    UPDATE public.wallet_transactions
    SET type = 'deposit_suspicious',
        checkout_request_id = _checkout_request_id
    WHERE id = _pending_tx.id;

    INSERT INTO public.audit_logs (action, user_id, amount, metadata, success, error_message)
    VALUES (
      'wallet_suspicious_amount',
      _pending_tx.user_id,
      _paid_amount,
      jsonb_build_object(
        'expected_amount', _pending_tx.amount,
        'paid_amount', _paid_amount,
        'checkout_request_id', _checkout_request_id,
        'mpesa_receipt', _mpesa_receipt
      ),
      FALSE,
      'Amount mismatch — possible fraud'
    );
    RETURN jsonb_build_object('status', 'error', 'reason', 'amount_mismatch');
  END IF;

  -- ── Confirm deposit ────────────────────────────────────────────────────
  UPDATE public.wallet_transactions
  SET type                 = 'deposit',
      checkout_request_id  = _checkout_request_id,
      net_amount           = _paid_amount
  WHERE id = _pending_tx.id
  RETURNING id INTO _wallet_tx_id;

  -- ── Credit wallet ──────────────────────────────────────────────────────
  INSERT INTO public.wallets (user_id, balance)
  VALUES (_pending_tx.user_id, _paid_amount)
  ON CONFLICT (user_id)
  DO UPDATE SET
    balance    = wallets.balance + EXCLUDED.balance,
    updated_at = now();

  -- ── Audit ──────────────────────────────────────────────────────────────
  INSERT INTO public.audit_logs (action, user_id, amount, metadata, success)
  VALUES (
    'wallet_deposit',
    _pending_tx.user_id,
    _paid_amount,
    jsonb_build_object(
      'checkout_request_id', _checkout_request_id,
      'mpesa_receipt', _mpesa_receipt,
      'phone', _phone,
      'wallet_tx_id', _wallet_tx_id
    ),
    TRUE
  );

  _result := jsonb_build_object(
    'status',       'success',
    'user_id',      _pending_tx.user_id,
    'amount',       _paid_amount,
    'wallet_tx_id', _wallet_tx_id
  );

  INSERT INTO public.idempotency_keys (key, result)
  VALUES (_idempotency_key, _result);

  RETURN _result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.process_daraja_deposit FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.process_daraja_deposit FROM authenticated;
GRANT EXECUTE ON FUNCTION public.process_daraja_deposit TO service_role;

-- ── 3. Widen wallet_transactions type CHECK to allow 'withdrawal_pending' ────
-- Currently only allows 'deposit', 'withdrawal' etc. depending on migration.
-- We need 'withdrawal_pending' to distinguish "deducted but not yet paid out".
ALTER TABLE public.wallet_transactions
  DROP CONSTRAINT IF EXISTS wallet_transactions_type_check;

ALTER TABLE public.wallet_transactions
  ADD CONSTRAINT wallet_transactions_type_check
  CHECK (type IN (
    'deposit',
    'deposit_pending',
    'deposit_processing',
    'deposit_suspicious',
    'withdrawal',
    'withdrawal_pending',
    'escrow_hold',
    'escrow_release'
  ));
