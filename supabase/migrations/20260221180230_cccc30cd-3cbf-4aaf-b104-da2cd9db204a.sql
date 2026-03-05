
-- 1. Atomic wallet functions
CREATE OR REPLACE FUNCTION public.add_wallet_funds(
  _user_id UUID,
  _amount NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_balance NUMERIC;
BEGIN
  IF _amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be positive';
  END IF;
  
  UPDATE wallets
  SET balance = balance + _amount,
      updated_at = now()
  WHERE user_id = _user_id
  RETURNING balance INTO new_balance;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found for user';
  END IF;
  
  RETURN new_balance;
END;
$$;

CREATE OR REPLACE FUNCTION public.withdraw_wallet_funds(
  _user_id UUID,
  _amount NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_balance NUMERIC;
BEGIN
  IF _amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be positive';
  END IF;
  
  UPDATE wallets
  SET balance = balance - _amount,
      updated_at = now()
  WHERE user_id = _user_id AND balance >= _amount
  RETURNING balance INTO new_balance;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient balance or wallet not found';
  END IF;
  
  RETURN new_balance;
END;
$$;

-- 2. Remove overly permissive wallet UPDATE policy
DROP POLICY IF EXISTS "Users can update own wallet" ON public.wallets;

-- 3. Add balance constraints
ALTER TABLE wallets ADD CONSTRAINT balance_non_negative CHECK (balance >= 0);

-- 4. Fix user_roles - remove self-insert policy (trigger handles it)
DROP POLICY IF EXISTS "Users can insert own roles" ON public.user_roles;

-- 5. Make storage buckets private
UPDATE storage.buckets SET public = false WHERE id IN ('transaction-documents', 'chat-images');

-- 6. Add checkout_request_id for idempotency
ALTER TABLE public.wallet_transactions ADD COLUMN IF NOT EXISTS checkout_request_id TEXT;
CREATE INDEX IF NOT EXISTS idx_wallet_tx_checkout ON public.wallet_transactions(checkout_request_id) WHERE checkout_request_id IS NOT NULL;

-- 7. Add token expiration and invalidate after use
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS approval_token_expires_at TIMESTAMPTZ DEFAULT (now() + interval '7 days');

-- 8. Grant execute on wallet functions
GRANT EXECUTE ON FUNCTION public.add_wallet_funds TO authenticated;
GRANT EXECUTE ON FUNCTION public.withdraw_wallet_funds TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_wallet_funds TO service_role;
GRANT EXECUTE ON FUNCTION public.withdraw_wallet_funds TO service_role;
