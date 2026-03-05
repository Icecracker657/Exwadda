-- ============================================================
-- MIGRATION: Security V2
-- - audit_logs table
-- - rate_limits table
-- - idempotency_keys table
-- - increment_rate_limit RPC
-- - approve_and_fund_transaction RPC  (row-locked SQL txn)
-- - release_escrow_funds RPC          (row-locked SQL txn)
-- - process_withdrawal RPC            (row-locked SQL txn)
-- - process_daraja_deposit RPC        (row-locked SQL txn)
-- ============================================================

-- ── 1. AUDIT LOGS ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id               UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  action           TEXT        NOT NULL,
  user_id          UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  transaction_id   UUID        REFERENCES public.transactions(id) ON DELETE SET NULL,
  amount           NUMERIC(15,2),
  metadata         JSONB,
  ip               TEXT,
  success          BOOLEAN     NOT NULL DEFAULT TRUE,
  error_message    TEXT
);

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- Users can only view their own audit entries; admins see all
DROP POLICY IF EXISTS "Users view own audit logs" ON public.audit_logs;
CREATE POLICY "Users view own audit logs"
ON public.audit_logs FOR SELECT
USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

-- No direct client writes — only service_role / edge functions
DROP POLICY IF EXISTS "No direct audit log insert" ON public.audit_logs;
CREATE POLICY "No direct audit log insert"
ON public.audit_logs FOR INSERT
WITH CHECK (FALSE);

GRANT ALL ON public.audit_logs TO service_role;

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_audit_user_id ON public.audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_transaction_id ON public.audit_logs(transaction_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON public.audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON public.audit_logs(created_at DESC);

-- ── 2. RATE LIMITS ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.rate_limits (
  key              TEXT        NOT NULL PRIMARY KEY,
  count            INTEGER     NOT NULL DEFAULT 1,
  window_start     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL
);

ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;

-- No client access at all
CREATE POLICY "No client access to rate_limits"
ON public.rate_limits FOR ALL
USING (FALSE);

GRANT ALL ON public.rate_limits TO service_role;

CREATE INDEX IF NOT EXISTS idx_rate_limits_expires ON public.rate_limits(expires_at);

-- ── 3. IDEMPOTENCY KEYS ──────────────────────────────────────────────────────
-- Tracks processed Daraja CheckoutRequestIDs to prevent double-processing
CREATE TABLE IF NOT EXISTS public.idempotency_keys (
  key              TEXT        NOT NULL PRIMARY KEY,
  processed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  result           JSONB,
  expires_at       TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days')
);

ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "No client access to idempotency_keys"
ON public.idempotency_keys FOR ALL
USING (FALSE);

GRANT ALL ON public.idempotency_keys TO service_role;

CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON public.idempotency_keys(expires_at);

-- ── 4. increment_rate_limit RPC ──────────────────────────────────────────────
-- Atomically inserts or increments a rate limit counter.
-- Returns {count, allowed} where count is the new request count.
CREATE OR REPLACE FUNCTION public.increment_rate_limit(
  _key          TEXT,
  _window_seconds INTEGER,
  _max_requests   INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _now        TIMESTAMPTZ := now();
  _expires_at TIMESTAMPTZ := _now + (_window_seconds || ' seconds')::INTERVAL;
  _count      INTEGER;
BEGIN
  -- Upsert: insert new counter or increment existing
  INSERT INTO public.rate_limits (key, count, window_start, expires_at)
  VALUES (_key, 1, _now, _expires_at)
  ON CONFLICT (key) DO UPDATE
    SET count = CASE
          -- If window has expired, reset counter
          WHEN rate_limits.expires_at < _now THEN 1
          ELSE rate_limits.count + 1
        END,
        window_start = CASE
          WHEN rate_limits.expires_at < _now THEN _now
          ELSE rate_limits.window_start
        END,
        expires_at = CASE
          WHEN rate_limits.expires_at < _now THEN _expires_at
          ELSE rate_limits.expires_at
        END
  RETURNING count INTO _count;

  RETURN jsonb_build_object(
    'count', _count,
    'allowed', _count <= _max_requests
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.increment_rate_limit FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_rate_limit TO service_role;

-- ── 5. cleanup_rate_limits — purge expired entries (call via pg_cron) ────────
CREATE OR REPLACE FUNCTION public.cleanup_expired_rate_limits()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _deleted INTEGER;
BEGIN
  DELETE FROM public.rate_limits WHERE expires_at < now();
  GET DIAGNOSTICS _deleted = ROW_COUNT;
  DELETE FROM public.idempotency_keys WHERE expires_at < now();
  RETURN _deleted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cleanup_expired_rate_limits TO service_role;

-- ── 6. process_daraja_deposit RPC ────────────────────────────────────────────
-- Atomic Daraja deposit with idempotency key, row locking, and audit log.
-- Called from daraja-callback edge function instead of individual queries.
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
  -- ── Idempotency: check if already processed ────────────────────────────
  IF EXISTS (
    SELECT 1 FROM public.idempotency_keys
    WHERE key = _idempotency_key AND expires_at > now()
  ) THEN
    SELECT result INTO _result
    FROM public.idempotency_keys
    WHERE key = _idempotency_key;
    RETURN COALESCE(_result, jsonb_build_object('status', 'already_processed'));
  END IF;

  -- ── Find matching pending transaction (with FOR UPDATE lock) ───────────
  SELECT wt.* INTO _pending_tx
  FROM public.wallet_transactions wt
  WHERE wt.checkout_request_id = _checkout_request_id
    AND wt.type = 'deposit_pending'
  FOR UPDATE NOWAIT;

  IF NOT FOUND THEN
    -- Try fallback: phone + amount within 30 minutes
    SELECT wt.* INTO _pending_tx
    FROM public.wallet_transactions wt
    WHERE wt.type = 'deposit_pending'
      AND wt.phone = _phone
      AND wt.amount = _paid_amount
      AND wt.created_at >= now() - interval '30 minutes'
    ORDER BY wt.created_at DESC
    LIMIT 1
    FOR UPDATE NOWAIT;

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
    -- Mark suspicious
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

  -- ── Mark deposit as confirmed ──────────────────────────────────────────
  UPDATE public.wallet_transactions
  SET type = 'deposit',
      checkout_request_id = _checkout_request_id,
      net_amount = _paid_amount
  WHERE id = _pending_tx.id
  RETURNING id INTO _wallet_tx_id;

  -- ── Credit wallet (atomic upsert) ─────────────────────────────────────
  INSERT INTO public.wallets (user_id, balance)
  VALUES (_pending_tx.user_id, _paid_amount)
  ON CONFLICT (user_id)
  DO UPDATE SET balance = wallets.balance + EXCLUDED.balance;

  -- ── Audit log ─────────────────────────────────────────────────────────
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

  -- ── Store idempotency key so replays are ignored ───────────────────────
  _result := jsonb_build_object(
    'status', 'success',
    'user_id', _pending_tx.user_id,
    'amount', _paid_amount,
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

-- ── 7. approve_and_fund_transaction RPC ─────────────────────────────────────
-- Atomically validates token, deducts wallet, creates escrow hold.
-- Called from approve-transaction edge function.
CREATE OR REPLACE FUNCTION public.approve_and_fund_transaction(
  _transaction_id  UUID,
  _approval_token  TEXT,
  _idempotency_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _tx          RECORD;
  _buyer_id    UUID;
  _buyer_total NUMERIC;
  _result      JSONB;
BEGIN
  -- ── Idempotency ────────────────────────────────────────────────────────
  IF EXISTS (
    SELECT 1 FROM public.idempotency_keys
    WHERE key = _idempotency_key AND expires_at > now()
  ) THEN
    SELECT result INTO _result FROM public.idempotency_keys WHERE key = _idempotency_key;
    RETURN COALESCE(_result, jsonb_build_object('status', 'already_processed'));
  END IF;

  -- ── Lock transaction row ───────────────────────────────────────────────
  SELECT * INTO _tx
  FROM public.transactions
  WHERE id = _transaction_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'transaction_not_found');
  END IF;

  -- ── Validate token ─────────────────────────────────────────────────────
  IF _tx.approval_token IS DISTINCT FROM _approval_token THEN
    INSERT INTO public.audit_logs (action, transaction_id, success, error_message)
    VALUES ('transaction_approved', _transaction_id, FALSE, 'Invalid approval token');
    RETURN jsonb_build_object('status', 'error', 'reason', 'invalid_token');
  END IF;

  IF _tx.approval_token_expires_at IS NOT NULL AND _tx.approval_token_expires_at < now() THEN
    INSERT INTO public.audit_logs (action, transaction_id, success, error_message)
    VALUES ('transaction_approved', _transaction_id, FALSE, 'Approval token expired');
    RETURN jsonb_build_object('status', 'error', 'reason', 'token_expired');
  END IF;

  -- ── Status guard ───────────────────────────────────────────────────────
  IF _tx.status <> 'pending_approval' THEN
    RETURN jsonb_build_object('status', 'already_processed', 'tx_status', _tx.status);
  END IF;

  -- ── Invalidate token immediately (one-time use) ────────────────────────
  UPDATE public.transactions
  SET approval_token = NULL,
      approval_token_expires_at = NULL
  WHERE id = _transaction_id;

  -- ── Compute buyer's total ──────────────────────────────────────────────
  _buyer_id := COALESCE(_tx.buyer_id, _tx.created_by);
  _buyer_total := CASE
    WHEN _tx.fee_payer = 'buyer'  THEN _tx.total
    WHEN _tx.fee_payer = 'split'  THEN _tx.amount + ROUND(_tx.fee / 2)
    ELSE _tx.amount  -- seller pays fee
  END;

  -- ── Lock buyer's wallet row ────────────────────────────────────────────
  DECLARE
    _wallet_balance NUMERIC;
  BEGIN
    SELECT balance INTO _wallet_balance
    FROM public.wallets
    WHERE user_id = _buyer_id
    FOR UPDATE;

    IF NOT FOUND OR _wallet_balance < _buyer_total THEN
      -- Insufficient funds — approve but don't fund
      UPDATE public.transactions
      SET status = 'approved',
          approved_at = now(),
          buyer_id = _buyer_id
      WHERE id = _transaction_id;

      INSERT INTO public.audit_logs (action, user_id, transaction_id, amount, success, error_message)
      VALUES (
        'transaction_approved',
        _buyer_id,
        _transaction_id,
        _buyer_total,
        FALSE,
        'Insufficient wallet balance — transaction approved but not funded'
      );

      RETURN jsonb_build_object(
        'status', 'approved_low_balance',
        'buyer_id', _buyer_id,
        'required', _buyer_total,
        'available', COALESCE(_wallet_balance, 0)
      );
    END IF;

    -- ── Deduct from wallet ─────────────────────────────────────────────
    UPDATE public.wallets
    SET balance = balance - _buyer_total
    WHERE user_id = _buyer_id;
  END;

  -- ── Create escrow hold ─────────────────────────────────────────────────
  INSERT INTO public.escrow_holds (transaction_id, user_id, amount, status)
  VALUES (_transaction_id, _buyer_id, _buyer_total, 'held');

  -- ── Record escrow_hold wallet transaction ──────────────────────────────
  INSERT INTO public.wallet_transactions (user_id, type, amount, fee, net_amount)
  VALUES (_buyer_id, 'escrow_hold', _buyer_total, _tx.fee, _buyer_total);

  -- ── Update transaction to funded ───────────────────────────────────────
  UPDATE public.transactions
  SET status     = 'funded',
      approved_at = now(),
      funded_at   = now(),
      buyer_id    = _buyer_id
  WHERE id = _transaction_id;

  -- ── Audit ──────────────────────────────────────────────────────────────
  INSERT INTO public.audit_logs (action, user_id, transaction_id, amount, success)
  VALUES ('transaction_funded', _buyer_id, _transaction_id, _buyer_total, TRUE);

  _result := jsonb_build_object(
    'status', 'funded',
    'buyer_id', _buyer_id,
    'amount_held', _buyer_total,
    'transaction_id', _transaction_id
  );

  INSERT INTO public.idempotency_keys (key, result)
  VALUES (_idempotency_key, _result);

  RETURN _result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.approve_and_fund_transaction FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.approve_and_fund_transaction FROM authenticated;
GRANT EXECUTE ON FUNCTION public.approve_and_fund_transaction TO service_role;

-- ── 8. release_escrow_funds RPC ──────────────────────────────────────────────
-- Atomically releases escrow to seller + broker with row locking.
CREATE OR REPLACE FUNCTION public.release_escrow_funds(
  _transaction_id  UUID,
  _buyer_id        UUID,
  _idempotency_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _tx              RECORD;
  _escrow          RECORD;
  _seller_payout   NUMERIC;
  _broker_amount   NUMERIC;
  _result          JSONB;
BEGIN
  -- ── Idempotency ────────────────────────────────────────────────────────
  IF EXISTS (
    SELECT 1 FROM public.idempotency_keys
    WHERE key = _idempotency_key AND expires_at > now()
  ) THEN
    SELECT result INTO _result FROM public.idempotency_keys WHERE key = _idempotency_key;
    RETURN COALESCE(_result, jsonb_build_object('status', 'already_processed'));
  END IF;

  -- ── Lock transaction row ───────────────────────────────────────────────
  SELECT * INTO _tx
  FROM public.transactions
  WHERE id = _transaction_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'transaction_not_found');
  END IF;

  -- ── Authorization ──────────────────────────────────────────────────────
  IF _tx.buyer_id <> _buyer_id THEN
    INSERT INTO public.audit_logs (action, user_id, transaction_id, success, error_message)
    VALUES ('transaction_released', _buyer_id, _transaction_id, FALSE, 'Unauthorized: caller is not the buyer');
    RETURN jsonb_build_object('status', 'error', 'reason', 'unauthorized');
  END IF;

  -- ── Status guard ───────────────────────────────────────────────────────
  IF _tx.status <> 'accepted' OR NOT _tx.product_received THEN
    RETURN jsonb_build_object(
      'status', 'error',
      'reason', 'invalid_state',
      'tx_status', _tx.status,
      'product_received', _tx.product_received
    );
  END IF;

  -- ── Lock escrow hold ───────────────────────────────────────────────────
  SELECT * INTO _escrow
  FROM public.escrow_holds
  WHERE transaction_id = _transaction_id AND status = 'held'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'escrow_not_found');
  END IF;

  -- ── Compute payouts ────────────────────────────────────────────────────
  _broker_amount := COALESCE(_tx.broker_commission, 0);
  _seller_payout := CASE
    WHEN _tx.fee_payer = 'buyer'  THEN _tx.amount
    WHEN _tx.fee_payer = 'seller' THEN _tx.amount - _tx.fee
    ELSE _tx.amount - ROUND(_tx.fee / 2)
  END - _broker_amount;

  IF _seller_payout < 0 THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'invalid_payout_calculation');
  END IF;

  -- ── Credit seller ──────────────────────────────────────────────────────
  IF _tx.seller_id IS NOT NULL THEN
    INSERT INTO public.wallets (user_id, balance)
    VALUES (_tx.seller_id, _seller_payout)
    ON CONFLICT (user_id)
    DO UPDATE SET balance = wallets.balance + EXCLUDED.balance;

    INSERT INTO public.wallet_transactions (user_id, type, amount, fee, net_amount)
    VALUES (_tx.seller_id, 'escrow_release', _seller_payout, 0, _seller_payout);
  END IF;

  -- ── Credit broker ──────────────────────────────────────────────────────
  IF _tx.broker_id IS NOT NULL AND _broker_amount > 0 THEN
    INSERT INTO public.wallets (user_id, balance)
    VALUES (_tx.broker_id, _broker_amount)
    ON CONFLICT (user_id)
    DO UPDATE SET balance = wallets.balance + EXCLUDED.balance;

    INSERT INTO public.wallet_transactions (user_id, type, amount, fee, net_amount)
    VALUES (_tx.broker_id, 'escrow_release', _broker_amount, 0, _broker_amount);
  END IF;

  -- ── Release escrow hold ────────────────────────────────────────────────
  UPDATE public.escrow_holds
  SET status = 'released'
  WHERE id = _escrow.id;

  -- ── Update transaction status ──────────────────────────────────────────
  UPDATE public.transactions
  SET status = 'released',
      released_at = now()
  WHERE id = _transaction_id;

  -- ── Audit ──────────────────────────────────────────────────────────────
  INSERT INTO public.audit_logs (action, user_id, transaction_id, amount, metadata, success)
  VALUES (
    'transaction_released',
    _buyer_id,
    _transaction_id,
    _tx.amount,
    jsonb_build_object(
      'seller_payout', _seller_payout,
      'broker_amount', _broker_amount,
      'seller_id', _tx.seller_id,
      'broker_id', _tx.broker_id
    ),
    TRUE
  );

  _result := jsonb_build_object(
    'status', 'released',
    'seller_payout', _seller_payout,
    'broker_amount', _broker_amount
  );

  INSERT INTO public.idempotency_keys (key, result)
  VALUES (_idempotency_key, _result);

  RETURN _result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.release_escrow_funds FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.release_escrow_funds FROM authenticated;
GRANT EXECUTE ON FUNCTION public.release_escrow_funds TO service_role;

-- ── 9. process_withdrawal RPC ────────────────────────────────────────────────
-- Atomically validates balance, deducts, records, and audits a withdrawal.
CREATE OR REPLACE FUNCTION public.process_withdrawal(
  _user_id         UUID,
  _amount          NUMERIC,
  _phone           TEXT,
  _idempotency_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _balance  NUMERIC;
  _result   JSONB;
BEGIN
  IF _amount <= 0 THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'invalid_amount');
  END IF;

  -- ── Idempotency ────────────────────────────────────────────────────────
  IF EXISTS (
    SELECT 1 FROM public.idempotency_keys
    WHERE key = _idempotency_key AND expires_at > now()
  ) THEN
    SELECT result INTO _result FROM public.idempotency_keys WHERE key = _idempotency_key;
    RETURN COALESCE(_result, jsonb_build_object('status', 'already_processed'));
  END IF;

  -- ── Lock wallet row ────────────────────────────────────────────────────
  SELECT balance INTO _balance
  FROM public.wallets
  WHERE user_id = _user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.audit_logs (action, user_id, amount, success, error_message)
    VALUES ('wallet_withdrawal', _user_id, _amount, FALSE, 'Wallet not found');
    RETURN jsonb_build_object('status', 'error', 'reason', 'wallet_not_found');
  END IF;

  IF _balance < _amount THEN
    INSERT INTO public.audit_logs (action, user_id, amount, metadata, success, error_message)
    VALUES (
      'wallet_withdrawal',
      _user_id,
      _amount,
      jsonb_build_object('available_balance', _balance, 'requested', _amount),
      FALSE,
      'Insufficient balance'
    );
    RETURN jsonb_build_object(
      'status', 'error',
      'reason', 'insufficient_balance',
      'available', _balance,
      'requested', _amount
    );
  END IF;

  -- ── Deduct balance ─────────────────────────────────────────────────────
  UPDATE public.wallets
  SET balance = balance - _amount
  WHERE user_id = _user_id;

  -- ── Record wallet transaction ──────────────────────────────────────────
  INSERT INTO public.wallet_transactions (user_id, type, amount, fee, net_amount, phone)
  VALUES (_user_id, 'withdrawal', _amount, 0, _amount, _phone);

  -- ── Audit ──────────────────────────────────────────────────────────────
  INSERT INTO public.audit_logs (action, user_id, amount, metadata, success)
  VALUES (
    'wallet_withdrawal',
    _user_id,
    _amount,
    jsonb_build_object('phone', _phone, 'balance_after', _balance - _amount),
    TRUE
  );

  _result := jsonb_build_object(
    'status', 'success',
    'amount', _amount,
    'balance_after', _balance - _amount
  );

  INSERT INTO public.idempotency_keys (key, result)
  VALUES (_idempotency_key, _result);

  RETURN _result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.process_withdrawal FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.process_withdrawal FROM authenticated;
GRANT EXECUTE ON FUNCTION public.process_withdrawal TO service_role;

-- ── 10. Safaricom IP whitelist table ─────────────────────────────────────────
-- Stored here so you can update IPs without redeploying code
CREATE TABLE IF NOT EXISTS public.safaricom_ip_whitelist (
  id          SERIAL      PRIMARY KEY,
  cidr        TEXT        NOT NULL UNIQUE,
  env         TEXT        NOT NULL CHECK (env IN ('sandbox', 'production', 'both')),
  description TEXT,
  active      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.safaricom_ip_whitelist ENABLE ROW LEVEL SECURITY;

CREATE POLICY "No client access to ip whitelist"
ON public.safaricom_ip_whitelist FOR ALL USING (FALSE);

GRANT SELECT ON public.safaricom_ip_whitelist TO service_role;
GRANT ALL ON public.safaricom_ip_whitelist TO service_role;

-- Seed with known Safaricom IPs
INSERT INTO public.safaricom_ip_whitelist (cidr, env, description) VALUES
  ('196.201.214.0/24',   'both',       'Safaricom core API range'),
  ('196.201.214.96/28',  'production', 'Safaricom production callback'),
  ('196.201.214.128/28', 'production', 'Safaricom production callback alt'),
  ('196.201.216.0/24',   'production', 'Safaricom production range 2'),
  ('196.201.217.0/24',   'production', 'Safaricom production range 3'),
  ('196.201.218.0/24',   'production', 'Safaricom production range 4')
ON CONFLICT (cidr) DO NOTHING;

-- RPC to check IP against DB whitelist
CREATE OR REPLACE FUNCTION public.is_safaricom_ip(
  _ip  TEXT,
  _env TEXT DEFAULT 'sandbox'
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _cidr       TEXT;
  _ip_int     BIGINT;
  _mask       BIGINT;
  _net_start  BIGINT;
  _net_end    BIGINT;
  _bits       INTEGER;
BEGIN
  -- Convert IP to integer
  BEGIN
    SELECT (
      (split_part(_ip, '.', 1)::BIGINT << 24) +
      (split_part(_ip, '.', 2)::BIGINT << 16) +
      (split_part(_ip, '.', 3)::BIGINT << 8)  +
       split_part(_ip, '.', 4)::BIGINT
    ) INTO _ip_int;
  EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
  END;

  FOR _cidr IN
    SELECT cidr FROM public.safaricom_ip_whitelist
    WHERE active = TRUE AND (env = _env OR env = 'both')
  LOOP
    _bits := split_part(_cidr, '/', 2)::INTEGER;
    _mask := ((2::BIGINT << (31 - _bits)) - 1) # ((2::BIGINT << 31) - 1);
    -- Simpler: use host() / masklen() if pg_inet extension available
    -- Fallback to manual CIDR check:
    IF _ip_int >= (
      (split_part(split_part(_cidr, '/', 1), '.', 1)::BIGINT << 24) +
      (split_part(split_part(_cidr, '/', 1), '.', 2)::BIGINT << 16) +
      (split_part(split_part(_cidr, '/', 1), '.', 3)::BIGINT << 8)  +
       split_part(split_part(_cidr, '/', 1), '.', 4)::BIGINT
    ) & _mask
    AND _ip_int <= (
      (
        (split_part(split_part(_cidr, '/', 1), '.', 1)::BIGINT << 24) +
        (split_part(split_part(_cidr, '/', 1), '.', 2)::BIGINT << 16) +
        (split_part(split_part(_cidr, '/', 1), '.', 3)::BIGINT << 8)  +
         split_part(split_part(_cidr, '/', 1), '.', 4)::BIGINT
      ) | (((1::BIGINT << (32 - _bits)) - 1))
    ) THEN
      RETURN TRUE;
    END IF;
  END LOOP;

  RETURN FALSE;
END;
$$;

-- Better: use PostgreSQL's built-in inet type for CIDR matching
-- Replace the above with this simpler version:
CREATE OR REPLACE FUNCTION public.is_safaricom_ip(
  _ip  TEXT,
  _env TEXT DEFAULT 'sandbox'
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.safaricom_ip_whitelist
    WHERE active = TRUE
      AND (env = _env OR env = 'both')
      AND _ip::inet <<= cidr::inet
  );
$$;

REVOKE EXECUTE ON FUNCTION public.is_safaricom_ip FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_safaricom_ip TO service_role;

-- ── 11. Realtime for audit_logs (admin dashboard) ────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE public.audit_logs;
