
-- Add 'broker' to app_role enum
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'broker';

-- Create transactions table
CREATE TABLE public.transactions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_by UUID NOT NULL,
  buyer_id UUID,
  seller_id UUID,
  broker_id UUID,
  role_in_transaction TEXT NOT NULL CHECK (role_in_transaction IN ('buyer', 'seller', 'broker')),
  counterparty_email TEXT NOT NULL,
  counterparty_phone TEXT,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  fee NUMERIC NOT NULL DEFAULT 0,
  fee_payer TEXT NOT NULL DEFAULT 'buyer' CHECK (fee_payer IN ('buyer', 'seller', 'split')),
  total NUMERIC NOT NULL,
  delivery_deadline DATE,
  status TEXT NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval', 'approved', 'funded', 'delivered', 'completed', 'disputed', 'cancelled')),
  approval_token UUID DEFAULT gen_random_uuid(),
  approved_at TIMESTAMP WITH TIME ZONE,
  funded_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

-- Policies: users can see transactions they're part of
CREATE POLICY "Users can view own transactions"
ON public.transactions FOR SELECT
TO authenticated
USING (
  auth.uid() = created_by OR auth.uid() = buyer_id OR auth.uid() = seller_id OR auth.uid() = broker_id
);

-- Creator can insert
CREATE POLICY "Users can create transactions"
ON public.transactions FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = created_by);

-- Participants can update (for approval, status changes)
CREATE POLICY "Participants can update transactions"
ON public.transactions FOR UPDATE
TO authenticated
USING (
  auth.uid() = created_by OR auth.uid() = buyer_id OR auth.uid() = seller_id OR auth.uid() = broker_id
);

-- Trigger for updated_at
CREATE TRIGGER update_transactions_updated_at
BEFORE UPDATE ON public.transactions
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Create escrow_holds table to track funds on hold
CREATE TABLE public.escrow_holds (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  transaction_id UUID NOT NULL REFERENCES public.transactions(id),
  user_id UUID NOT NULL,
  amount NUMERIC NOT NULL,
  status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'released', 'refunded')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.escrow_holds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own escrow holds"
ON public.escrow_holds FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "System can insert escrow holds"
ON public.escrow_holds FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_escrow_holds_updated_at
BEFORE UPDATE ON public.escrow_holds
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();
