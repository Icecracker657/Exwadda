import { useState, useEffect } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { User, ArrowDownToLine, ArrowUpFromLine, Clock, LogOut, Settings } from "lucide-react";
import { Separator } from "@/components/ui/separator";

interface AvatarDropdownProps {
  initials: string;
  profile: { first_name: string; last_name: string; phone?: string | null; email?: string | null } | null;
  onEditProfile: () => void;
  onSignOut: () => void;
}

interface WalletTransaction {
  id: string;
  type: string;
  amount: number;
  fee: number;
  net_amount: number;
  created_at: string;
}

const AvatarDropdown = ({ initials, profile, onEditProfile, onSignOut }: AvatarDropdownProps) => {
  const { user } = useAuth();
  const [history, setHistory] = useState<WalletTransaction[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (open && user) {
      (supabase as any)
        .from("wallet_transactions")
        .select("id, type, amount, fee, net_amount, created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(10)
        .then(({ data }: any) => {
          if (data) setHistory(data);
        });
    }
  }, [open, user]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground hover:ring-2 hover:ring-primary/50 transition-all cursor-pointer"
          title="Account menu"
        >
          {initials}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        {/* Profile header */}
        <div className="p-4 pb-2">
          <p className="font-heading font-semibold text-sm">
            {profile?.first_name} {profile?.last_name}
          </p>
          <p className="text-xs text-muted-foreground">{profile?.email || user?.email}</p>
        </div>
        <Separator />

        {/* Actions */}
        <div className="p-2">
          <button
            onClick={() => { onEditProfile(); setOpen(false); }}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-muted transition-colors"
          >
            <Settings className="h-4 w-4" /> Edit Profile
          </button>
          <button
            onClick={() => { onSignOut(); setOpen(false); }}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-accent hover:bg-muted transition-colors"
          >
            <LogOut className="h-4 w-4" /> Sign Out
          </button>
        </div>
        <Separator />

        {/* Transaction History */}
        <div className="p-3">
          <p className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1">
            <Clock className="h-3 w-3" /> Recent Wallet Activity
          </p>
          {history.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-3">No transactions yet</p>
          ) : (
            <div className="space-y-1.5 max-h-48 overflow-y-auto">
              {history.map((tx) => (
                <div key={tx.id} className="flex items-center justify-between rounded-md px-2 py-1.5 text-xs hover:bg-muted/50">
                  <div className="flex items-center gap-2">
                    {tx.type === "deposit" ? (
                      <ArrowDownToLine className="h-3.5 w-3.5 text-primary" />
                    ) : (
                      <ArrowUpFromLine className="h-3.5 w-3.5 text-accent" />
                    )}
                    <div>
                      <span className="font-medium capitalize">{tx.type}</span>
                      {tx.fee > 0 && (
                        <span className="text-muted-foreground ml-1">(fee: KES {tx.fee.toLocaleString()})</span>
                      )}
                    </div>
                  </div>
                  <div className="text-right">
                    <span className={tx.type === "deposit" ? "text-primary font-medium" : "text-accent font-medium"}>
                      {tx.type === "deposit" ? "+" : "-"} KES {tx.amount.toLocaleString()}
                    </span>
                    <p className="text-muted-foreground text-[10px]">
                      {new Date(tx.created_at).toLocaleDateString()}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};

export default AvatarDropdown;
