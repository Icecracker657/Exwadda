
-- Create transaction messages table
CREATE TABLE public.transaction_messages (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  transaction_id UUID NOT NULL REFERENCES public.transactions(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL,
  message TEXT,
  image_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.transaction_messages ENABLE ROW LEVEL SECURITY;

-- Participants can view messages
CREATE POLICY "Transaction participants can view messages"
ON public.transaction_messages
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.transactions t
    WHERE t.id = transaction_messages.transaction_id
    AND (auth.uid() = t.created_by OR auth.uid() = t.buyer_id OR auth.uid() = t.seller_id OR auth.uid() = t.broker_id)
  )
);

-- Participants can send messages
CREATE POLICY "Transaction participants can send messages"
ON public.transaction_messages
FOR INSERT
WITH CHECK (
  auth.uid() = sender_id
  AND EXISTS (
    SELECT 1 FROM public.transactions t
    WHERE t.id = transaction_messages.transaction_id
    AND (auth.uid() = t.created_by OR auth.uid() = t.buyer_id OR auth.uid() = t.seller_id OR auth.uid() = t.broker_id)
  )
);

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.transaction_messages;

-- Create storage bucket for chat images
INSERT INTO storage.buckets (id, name, public) VALUES ('chat-images', 'chat-images', true);

-- Storage policies for chat images
CREATE POLICY "Authenticated users can upload chat images"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'chat-images' AND auth.role() = 'authenticated');

CREATE POLICY "Anyone can view chat images"
ON storage.objects FOR SELECT
USING (bucket_id = 'chat-images');
