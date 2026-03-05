
-- Wallet transaction history (deposits & withdrawals)
CREATE TABLE public.wallet_transactions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('deposit', 'withdrawal')),
  amount NUMERIC NOT NULL,
  fee NUMERIC NOT NULL DEFAULT 0,
  net_amount NUMERIC NOT NULL,
  phone TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.wallet_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own wallet transactions"
  ON public.wallet_transactions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own wallet transactions"
  ON public.wallet_transactions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Add broker_commission column to transactions
ALTER TABLE public.transactions ADD COLUMN broker_commission NUMERIC DEFAULT 0;

-- Storage bucket for transaction documents
INSERT INTO storage.buckets (id, name, public) VALUES ('transaction-documents', 'transaction-documents', true);

CREATE POLICY "Users can upload transaction documents"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'transaction-documents' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Anyone can view transaction documents"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'transaction-documents');

CREATE POLICY "Users can delete own transaction documents"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'transaction-documents' AND auth.uid()::text = (storage.foldername(name))[1]);

-- Transaction documents reference table
CREATE TABLE public.transaction_documents (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  transaction_id UUID NOT NULL REFERENCES public.transactions(id) ON DELETE CASCADE,
  uploaded_by UUID NOT NULL,
  file_name TEXT NOT NULL,
  file_url TEXT NOT NULL,
  file_type TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.transaction_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Transaction participants can view documents"
  ON public.transaction_documents FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.transactions t
      WHERE t.id = transaction_id
      AND (auth.uid() = t.created_by OR auth.uid() = t.buyer_id OR auth.uid() = t.seller_id OR auth.uid() = t.broker_id)
    )
  );

CREATE POLICY "Users can upload documents"
  ON public.transaction_documents FOR INSERT
  WITH CHECK (auth.uid() = uploaded_by);
