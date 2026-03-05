-- ============================================================
-- MIGRATION: Fix All Blockers for Full End-to-End Flow
-- Timestamp: 20260225100000
--
-- Fixes:
--  1. profiles.role column missing — has_role() in migration 200000 queries
--     profiles.role which doesn't exist, so ALL admin checks return FALSE
--     and all users get no access. Add the column + backfill from user_roles.
--  2. has_role() signature conflict — original uses app_role type, new one
--     uses TEXT. Replace with a single canonical version that works for both.
--  3. wallets table — ensure every user gets a wallet row (handle_new_user
--     trigger inserts one, but in case it ever missed, upsert on first login).
--  4. transactions INSERT policy — service_role bypasses RLS so the edge
--     function works, but ensure the policy is clean.
--  5. profiles SELECT policy duplicate cleanup.
-- ============================================================

-- ── 1. Add role column to profiles (was missing) ─────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'both';

-- Backfill role from user_roles table
UPDATE public.profiles p
SET role = ur.role::TEXT
FROM public.user_roles ur
WHERE ur.user_id = p.user_id
  AND p.role = 'both';  -- only overwrite if still at default

-- ── 2. Fix has_role() — single canonical version using user_roles table ───────
-- Drop the TEXT version (from migration 200000) and replace with one
-- that works with both TEXT and app_role comparisons.
DROP FUNCTION IF EXISTS public.has_role(UUID, TEXT);
DROP FUNCTION IF EXISTS public.has_role(UUID, app_role);

CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id
      AND role::TEXT = _role
  );
$$;

-- Grant to authenticated so RLS policies work
GRANT EXECUTE ON FUNCTION public.has_role(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_role(UUID, TEXT) TO service_role;

-- ── 3. Fix handle_new_user trigger — also set profiles.role ──────────────────
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _role TEXT;
BEGIN
  _role := COALESCE(NEW.raw_user_meta_data->>'role', 'both');

  -- Insert profile with role
  INSERT INTO public.profiles (user_id, first_name, last_name, email, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'first_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'last_name', ''),
    NEW.email,
    _role
  )
  ON CONFLICT (user_id) DO UPDATE
    SET first_name = EXCLUDED.first_name,
        last_name  = EXCLUDED.last_name,
        email      = EXCLUDED.email,
        role       = EXCLUDED.role;

  -- Insert wallet (balance defaults to 0)
  INSERT INTO public.wallets (user_id, balance)
  VALUES (NEW.id, 0)
  ON CONFLICT (user_id) DO NOTHING;

  -- Insert user_roles
  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, _role::app_role)
  ON CONFLICT (user_id, role) DO NOTHING;

  RETURN NEW;
END;
$$;

-- ── 4. Fix RLS on profiles — clean up duplicate policies ─────────────────────
-- Drop all existing SELECT policies and recreate clean ones
DROP POLICY IF EXISTS "Users can view own profile"         ON public.profiles;
DROP POLICY IF EXISTS "Users view own profile"             ON public.profiles;
DROP POLICY IF EXISTS "Admin can view all profiles"        ON public.profiles;

CREATE POLICY "profiles_select"
ON public.profiles FOR SELECT
USING (
  auth.uid() = user_id
  OR public.has_role(auth.uid(), 'admin')
);

-- ── 5. Fix RLS on transactions — clean up duplicate policies ─────────────────
DROP POLICY IF EXISTS "Users can view own transactions"          ON public.transactions;
DROP POLICY IF EXISTS "Participants can view their transactions" ON public.transactions;
DROP POLICY IF EXISTS "Admin can view all transactions"          ON public.transactions;

CREATE POLICY "transactions_select"
ON public.transactions FOR SELECT
USING (
  auth.uid() = created_by
  OR auth.uid() = buyer_id
  OR auth.uid() = seller_id
  OR auth.uid() = broker_id
  OR public.has_role(auth.uid(), 'admin')
);

-- Keep INSERT policy (service_role bypasses anyway but good practice)
DROP POLICY IF EXISTS "Authenticated users can create transactions" ON public.transactions;
CREATE POLICY "transactions_insert"
ON public.transactions FOR INSERT
WITH CHECK (auth.uid() = created_by);

-- ── 6. Fix wallets SELECT policy ─────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can view own wallet" ON public.wallets;
DROP POLICY IF EXISTS "Users view own wallet"     ON public.wallets;

CREATE POLICY "wallets_select"
ON public.wallets FOR SELECT
USING (auth.uid() = user_id);

-- ── 7. Fix wallet_transactions SELECT ────────────────────────────────────────
DROP POLICY IF EXISTS "Users can view own wallet transactions" ON public.wallet_transactions;
DROP POLICY IF EXISTS "Users view own wallet transactions"     ON public.wallet_transactions;

CREATE POLICY "wallet_transactions_select"
ON public.wallet_transactions FOR SELECT
USING (
  auth.uid() = user_id
  OR public.has_role(auth.uid(), 'admin')
);

-- ── 8. Ensure wallets has a balance default and unique constraint ─────────────
ALTER TABLE public.wallets
  ALTER COLUMN balance SET DEFAULT 0;

ALTER TABLE public.wallets
  ADD CONSTRAINT wallets_balance_non_negative
  CHECK (balance >= 0);

-- ── 9. Make sure every existing auth user has a wallet (catch missed triggers) ─
INSERT INTO public.wallets (user_id, balance)
SELECT id, 0
FROM auth.users
WHERE id NOT IN (SELECT user_id FROM public.wallets)
ON CONFLICT (user_id) DO NOTHING;

-- ── 10. Ensure profiles.role is consistent with user_roles ───────────────────
-- Update profiles.role to match user_roles for any mismatches
UPDATE public.profiles p
SET role = (
  SELECT role::TEXT
  FROM public.user_roles ur
  WHERE ur.user_id = p.user_id
  LIMIT 1
)
WHERE EXISTS (
  SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.user_id
);
