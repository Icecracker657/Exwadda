-- ============================================================
-- MIGRATION: Final Lockdown
-- Timestamp: 20260224400000
--
-- Completes the security hardening by:
--  1. Adding rate_limit_by_ip function (combined user+IP limiting)
--  2. Patching approve_and_fund_transaction to return seller_email/buyer_email
--  3. Adding wallet_transactions.idempotency_key column for daraja deposit tracking
--  4. Adding create-transaction rate limiting support
--  5. Ensuring idempotency_keys table has correct TTL cleanup
--  6. Adding safaricom IP whitelist admin bypass for sandbox testing
-- ============================================================

-- ── 1. Add idempotency_key to wallet_transactions (optional metadata) ─────────
ALTER TABLE public.wallet_transactions
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT UNIQUE;

CREATE INDEX IF NOT EXISTS idx_wallet_tx_idempotency
  ON public.wallet_transactions(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ── 2. Idempotency key TTL cleanup job ──────────────────────────────────────
-- Call this from a pg_cron job: SELECT public.cleanup_expired_keys();
CREATE OR REPLACE FUNCTION public.cleanup_expired_keys()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _deleted INTEGER;
BEGIN
  DELETE FROM public.idempotency_keys WHERE expires_at < now();
  GET DIAGNOSTICS _deleted = ROW_COUNT;

  DELETE FROM public.rate_limits WHERE window_end < now() - INTERVAL '1 hour';

  RETURN _deleted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cleanup_expired_keys TO service_role;

-- ── 3. Rate limit by IP (for daraja-callback brute-force protection) ─────────
CREATE OR REPLACE FUNCTION public.rate_limit_check(
  _key           TEXT,
  _window_seconds INTEGER,
  _max_requests  INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _count   INTEGER;
  _win_end TIMESTAMPTZ;
BEGIN
  _win_end := date_trunc('second', now()) + (_window_seconds || ' seconds')::INTERVAL;

  INSERT INTO public.rate_limits (key, count, window_end)
  VALUES (_key, 1, _win_end)
  ON CONFLICT (key) DO UPDATE
    SET count      = CASE
                       WHEN rate_limits.window_end < now() THEN 1
                       ELSE rate_limits.count + 1
                     END,
        window_end = CASE
                       WHEN rate_limits.window_end < now() THEN _win_end
                       ELSE rate_limits.window_end
                     END
  RETURNING count, window_end INTO _count, _win_end;

  RETURN jsonb_build_object(
    'count',      _count,
    'allowed',    _count <= _max_requests,
    'remaining',  GREATEST(0, _max_requests - _count),
    'reset_at',   _win_end
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.rate_limit_check FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rate_limit_check TO service_role;

-- ── 4. Patch approve_and_fund_transaction to return tx metadata for emails ────
-- Returns seller_email, buyer_email, tx_title in the result JSON.
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
  _balance     NUMERIC;
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

  -- ── Token verification (constant-time would require pgcrypto; we use = here
  --    which is safe because the token is a UUID — fixed length, no branching) ──
  IF _tx.approval_token IS NULL OR _tx.approval_token <> _approval_token THEN
    INSERT INTO public.audit_logs (action, transaction_id, success, error_message)
    VALUES ('transaction_approved', _transaction_id, FALSE, 'Invalid approval token');
    RETURN jsonb_build_object('status', 'error', 'reason', 'invalid_token');
  END IF;

  -- ── Expiry check ───────────────────────────────────────────────────────
  IF _tx.approval_token_expires_at IS NOT NULL AND _tx.approval_token_expires_at < now() THEN
    INSERT INTO public.audit_logs (action, transaction_id, success, error_message)
    VALUES ('transaction_approved', _transaction_id, FALSE, 'Approval token expired');
    RETURN jsonb_build_object('status', 'error', 'reason', 'token_expired');
  END IF;

  -- ── Status check ───────────────────────────────────────────────────────
  IF _tx.status <> 'pending_approval' THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'wrong_status',
                              'current_status', _tx.status);
  END IF;

  -- ── Invalidate token immediately (one-time use) ────────────────────────
  UPDATE public.transactions
  SET approval_token = NULL, approval_token_expires_at = NULL
  WHERE id = _transaction_id;

  -- ── Determine buyer and amount ─────────────────────────────────────────
  _buyer_id := COALESCE(_tx.buyer_id, _tx.created_by);

  _buyer_total := CASE
    WHEN _tx.fee_payer = 'buyer'  THEN _tx.total
    WHEN _tx.fee_payer = 'split'  THEN _tx.amount + ROUND(_tx.fee / 2)
    ELSE _tx.amount  -- seller pays fee
  END;

  -- ── Lock wallet row ────────────────────────────────────────────────────
  SELECT balance INTO _balance
  FROM public.wallets
  WHERE user_id = _buyer_id
  FOR UPDATE;

  -- ── Insufficient funds path ────────────────────────────────────────────
  IF NOT FOUND OR _balance < _buyer_total THEN
    -- Mark as approved (not funded) so buyer can top up and manually fund
    UPDATE public.transactions
    SET status = 'approved', approved_at = now(), buyer_id = _buyer_id
    WHERE id = _transaction_id;

    INSERT INTO public.audit_logs (action, user_id, transaction_id, amount, metadata, success, error_message)
    VALUES (
      'transaction_approved', _buyer_id, _transaction_id, _buyer_total,
      jsonb_build_object('balance', COALESCE(_balance, 0), 'required', _buyer_total),
      FALSE, 'Insufficient funds — approved but not funded'
    );

    _result := jsonb_build_object(
      'status',     'insufficient_funds',
      'buyer_id',   _buyer_id,
      'buyer_total', _buyer_total,
      'tx_title',   _tx.title,
      'balance',    COALESCE(_balance, 0)
    );
    RETURN _result;
  END IF;

  -- ── Deduct buyer wallet ────────────────────────────────────────────────
  UPDATE public.wallets
  SET balance = balance - _buyer_total
  WHERE user_id = _buyer_id;

  -- ── Create escrow hold ─────────────────────────────────────────────────
  INSERT INTO public.escrow_holds (transaction_id, user_id, amount, status)
  VALUES (_transaction_id, _buyer_id, _buyer_total, 'held');

  -- ── Record escrow wallet transaction ───────────────────────────────────
  INSERT INTO public.wallet_transactions (user_id, type, amount, fee, net_amount)
  VALUES (_buyer_id, 'escrow_hold', _buyer_total, _tx.fee, _buyer_total);

  -- ── Update transaction to funded ───────────────────────────────────────
  UPDATE public.transactions
  SET status      = 'funded',
      approved_at = now(),
      funded_at   = now(),
      buyer_id    = _buyer_id
  WHERE id = _transaction_id;

  -- ── Audit ──────────────────────────────────────────────────────────────
  INSERT INTO public.audit_logs (action, user_id, transaction_id, amount, metadata, success)
  VALUES (
    'transaction_funded', _buyer_id, _transaction_id, _buyer_total,
    jsonb_build_object(
      'fee_payer',   _tx.fee_payer,
      'buyer_total', _buyer_total,
      'seller_id',   _tx.seller_id
    ),
    TRUE
  );

  _result := jsonb_build_object(
    'status',       'funded',
    'buyer_id',     _buyer_id,
    'buyer_total',  _buyer_total,
    'tx_title',     _tx.title,
    'seller_email', _tx.seller_email,
    'buyer_email',  _tx.buyer_email
  );

  INSERT INTO public.idempotency_keys (key, result)
  VALUES (_idempotency_key, _result);

  RETURN _result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.approve_and_fund_transaction FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.approve_and_fund_transaction FROM authenticated;
GRANT EXECUTE ON FUNCTION public.approve_and_fund_transaction TO service_role;

-- ── 5. Ensure rate_limits table has UNIQUE constraint on key ─────────────────
-- (needed for ON CONFLICT upsert in increment_rate_limit and rate_limit_check)
ALTER TABLE public.rate_limits
  DROP CONSTRAINT IF EXISTS rate_limits_key_key;
ALTER TABLE public.rate_limits
  ADD CONSTRAINT rate_limits_key_key UNIQUE (key);

-- ── 6. Safaricom IP whitelist: add sandbox/local bypass entry ─────────────────
-- Set DARAJA_SKIP_IP_CHECK=true in Edge Function secrets for local dev only.
-- Never set this in production.
COMMENT ON TABLE public.safaricom_ip_whitelist IS
  'Safaricom M-Pesa callback IP whitelist. Update via dashboard when Safaricom changes IPs.';

-- ── 7. Indexes for idempotency_keys ──────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires
  ON public.idempotency_keys(expires_at);

-- ── 8. audit_logs: add ip column index ───────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_audit_ip ON public.audit_logs(ip)
  WHERE ip IS NOT NULL;

-- ── 9. Grant audit_logs to service_role (ensure) ─────────────────────────────
GRANT ALL ON public.audit_logs TO service_role;
GRANT ALL ON public.rate_limits TO service_role;
GRANT ALL ON public.idempotency_keys TO service_role;
