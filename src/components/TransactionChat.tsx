import { useState, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Send, ImagePlus, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";

interface Message {
  id: string;
  sender_id: string;
  message: string | null;
  image_url: string | null;
  created_at: string;
}

interface SenderProfile {
  user_id: string;
  first_name: string;
  last_name: string;
}

interface TransactionChatProps {
  transactionId: string;
}

const TransactionChat = ({ transactionId }: TransactionChatProps) => {
  const { user } = useAuth();
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [profiles, setProfiles] = useState<Record<string, SenderProfile>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch messages
  useEffect(() => {
    const fetchMessages = async () => {
      const { data, error } = await supabase
        .from("transaction_messages")
        .select("*")
        .eq("transaction_id", transactionId)
        .order("created_at", { ascending: true });

      if (!error && data) {
        setMessages(data);
        // Fetch profiles for senders
        const senderIds = [...new Set(data.map((m) => m.sender_id))];
        if (senderIds.length > 0) {
          const { data: profileData } = await supabase
            .from("profiles")
            .select("user_id, first_name, last_name")
            .in("user_id", senderIds);
          if (profileData) {
            const map: Record<string, SenderProfile> = {};
            profileData.forEach((p) => (map[p.user_id] = p));
            setProfiles(map);
          }
        }
      }
    };

    fetchMessages();

    // Subscribe to realtime
    const channel = supabase
      .channel(`chat-${transactionId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "transaction_messages",
          filter: `transaction_id=eq.${transactionId}`,
        },
        async (payload) => {
          const newMsg = payload.new as Message;
          setMessages((prev) => [...prev, newMsg]);

          // Fetch profile if unknown
          if (!profiles[newMsg.sender_id]) {
            const { data } = await supabase
              .from("profiles")
              .select("user_id, first_name, last_name")
              .eq("user_id", newMsg.sender_id)
              .single();
            if (data) {
              setProfiles((prev) => ({ ...prev, [data.user_id]: data }));
            }
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [transactionId]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Image must be under 5MB");
      return;
    }
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
  };

  const uploadImage = async (file: File): Promise<string | null> => {
    const ext = file.name.split(".").pop();
    const path = `${transactionId}/${crypto.randomUUID()}.${ext}`;
    const { error } = await supabase.storage
      .from("chat-images")
      .upload(path, file);
    if (error) {
      toast.error("Failed to upload image");
      return null;
    }
    const { data } = supabase.storage.from("chat-images").getPublicUrl(path);
    return data.publicUrl;
  };

  const handleSend = async () => {
    if (!user || (!newMessage.trim() && !imageFile)) return;
    setSending(true);

    let imageUrl: string | null = null;
    if (imageFile) {
      setUploading(true);
      imageUrl = await uploadImage(imageFile);
      setUploading(false);
      if (!imageUrl && !newMessage.trim()) {
        setSending(false);
        return;
      }
    }

    const { error } = await supabase.from("transaction_messages").insert({
      transaction_id: transactionId,
      sender_id: user.id,
      message: newMessage.trim() || null,
      image_url: imageUrl,
    });

    if (error) {
      toast.error("Failed to send message");
    } else {
      setNewMessage("");
      setImageFile(null);
      setImagePreview(null);
    }
    setSending(false);
  };

  const getSenderName = (senderId: string) => {
    if (senderId === user?.id) return "You";
    const p = profiles[senderId];
    return p ? `${p.first_name} ${p.last_name}`.trim() || "User" : "User";
  };

  const getInitials = (senderId: string) => {
    const p = profiles[senderId];
    if (!p) return "?";
    return `${p.first_name?.[0] || ""}${p.last_name?.[0] || ""}`.toUpperCase() || "?";
  };

  return (
    <div className="flex flex-col h-[400px]">
      <ScrollArea className="flex-1 pr-3" ref={scrollRef as any}>
        <div className="space-y-3 p-1">
          {messages.length === 0 && (
            <p className="text-center text-sm text-muted-foreground py-8">
              No messages yet. Start the conversation!
            </p>
          )}
          {messages.map((msg) => {
            const isMe = msg.sender_id === user?.id;
            return (
              <div
                key={msg.id}
                className={`flex gap-2 ${isMe ? "flex-row-reverse" : ""}`}
              >
                <Avatar className="h-8 w-8 shrink-0">
                  <AvatarFallback className={`text-xs ${isMe ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
                    {isMe ? "You" : getInitials(msg.sender_id)}
                  </AvatarFallback>
                </Avatar>
                <div className={`max-w-[70%] space-y-1 ${isMe ? "items-end" : ""}`}>
                  <div className={`flex items-baseline gap-2 ${isMe ? "flex-row-reverse" : ""}`}>
                    <span className="text-xs font-medium">{getSenderName(msg.sender_id)}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {format(new Date(msg.created_at), "h:mm a")}
                    </span>
                  </div>
                  <div
                    className={`rounded-xl px-3 py-2 text-sm ${
                      isMe
                        ? "bg-primary text-primary-foreground rounded-tr-sm"
                        : "bg-muted rounded-tl-sm"
                    }`}
                  >
                    {msg.image_url && (
                      <a href={msg.image_url} target="_blank" rel="noopener noreferrer">
                        <img
                          src={msg.image_url}
                          alt="Shared image"
                          className="rounded-lg max-w-full max-h-48 mb-1 cursor-pointer hover:opacity-90 transition"
                        />
                      </a>
                    )}
                    {msg.message && <p>{msg.message}</p>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </ScrollArea>

      {/* Image preview */}
      {imagePreview && (
        <div className="relative mx-2 mt-2 inline-block w-fit">
          <img src={imagePreview} alt="Preview" className="h-16 rounded-lg border" />
          <button
            onClick={() => { setImageFile(null); setImagePreview(null); }}
            className="absolute -top-1 -right-1 rounded-full bg-destructive text-destructive-foreground p-0.5"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* Input bar */}
      <div className="flex items-center gap-2 pt-3 border-t mt-2">
        <input
          type="file"
          ref={fileInputRef}
          className="hidden"
          accept="image/*"
          onChange={handleImageSelect}
        />
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0"
          onClick={() => fileInputRef.current?.click()}
          disabled={sending}
        >
          <ImagePlus className="h-5 w-5 text-muted-foreground" />
        </Button>
        <Input
          placeholder="Type a message..."
          value={newMessage}
          onChange={(e) => setNewMessage(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
          disabled={sending}
          className="flex-1"
        />
        <Button
          variant="hero"
          size="icon"
          className="shrink-0"
          onClick={handleSend}
          disabled={sending || (!newMessage.trim() && !imageFile)}
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
};

export default TransactionChat;
