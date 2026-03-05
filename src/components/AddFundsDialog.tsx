import { useState, useEffect, useRef } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "@/hooks/use-toast";
import { Smartphone, Loader2, CheckCircle2 } from "lucide-react";

interface AddFundsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentBalance: number;
  onSuccess: () => void;
}

const AddFundsDialog = ({ open, onOpenChange, currentBalance, onSuccess }: AddFundsDialogProps) => {
  const { user } = useAuth();
  const [amount, setAmount] = useState("");
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [stkSent, setStkSent] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [pollCount, setPollCount] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const initialBalanceRef = useRef<number>(currentBalance);

  const numAmount = Number(amount) || 0;

  // Poll wallet balance every 3 seconds after STK push until deposit is confirmed
  useEffect(() => {
    if (!stkSent || confirmed || !user) return;

    initialBalanceRef.current = currentBalance;

    pollRef.current = setInterval(async () => {
      setPollCount(c => c + 1);

      const { data } = await supabase
        .from("wallets")
        .select("balance")
        .eq("user_id", user.id)
        .single();

      if (data && Number(data.balance) > initialBalanceRef.current) {
        // Balance went up — deposit confirmed!
        clearInterval(pollRef.current!);
        setConfirmed(true);
        onSuccess();
        toast({
          title: "Deposit confirmed! ✅",
          description: `KES ${numAmount.toLocaleString()} has been added to your wallet.`,
        });
      }
    }, 3000);

    // Stop polling after 3 minutes (60 × 3s)
    const timeout = setTimeout(() => {
      clearInterval(pollRef.current!);
      // If not confirmed, prompt user to check
      if (!confirmed) {
        onSuccess(); // refresh balance anyway in case it updated
      }
    }, 180_000);

    return () => {
      clearInterval(pollRef.current!);
      clearTimeout(timeout);
    };
  }, [stkSent]);

  const handleDeposit = async () => {
    if (!user || !amount || Number(amount) <= 0 || !phone) return;
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("daraja-stk-push", {
        body: { phone, amount: Number(amount) },
      });

      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);

      if (data?.success) {
        setStkSent(true);
        toast({
          title: "Check your phone 📱",
          description: "Enter your M-Pesa PIN to confirm the deposit.",
        });
      } else {
        throw new Error("STK push failed. Please try again.");
      }
    } catch (err: any) {
      toast({ title: "Deposit failed", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleClose = (isOpen: boolean) => {
    if (!isOpen) {
      clearInterval(pollRef.current!);
      setStkSent(false);
      setConfirmed(false);
      setPollCount(0);
      setAmount("");
      setPhone("");
    }
    onOpenChange(isOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-heading">Add Funds to Wallet</DialogTitle>
          <DialogDescription>Deposit money into your ExWadda wallet via M-Pesa.</DialogDescription>
        </DialogHeader>

        {confirmed ? (
          <div className="py-8 text-center space-y-4">
            <CheckCircle2 className="h-12 w-12 text-primary mx-auto" />
            <p className="font-heading font-bold text-lg text-primary">Deposit Confirmed!</p>
            <p className="text-sm text-muted-foreground">
              KES {numAmount.toLocaleString()} has been added to your wallet.
            </p>
            <Button variant="hero" onClick={() => handleClose(false)}>
              Done
            </Button>
          </div>
        ) : stkSent ? (
          <div className="py-6 text-center space-y-4">
            <Loader2 className="h-10 w-10 animate-spin text-primary mx-auto" />
            <p className="font-heading font-bold text-lg">Waiting for payment…</p>
            <div className="rounded-lg bg-primary/5 border border-primary/20 p-4 text-sm text-left space-y-2">
              <p className="font-medium">On your phone:</p>
              <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
                <li>Open the M-Pesa prompt</li>
                <li>Enter your M-Pesa PIN</li>
                <li>Press OK to confirm</li>
              </ol>
            </div>
            <p className="text-xs text-muted-foreground">
              {pollCount > 0
                ? `Checking for confirmation… (${pollCount})`
                : "Your balance will update automatically once confirmed."}
            </p>
            <Button variant="outline" size="sm" onClick={() => handleClose(false)}>
              Close (balance updates in background)
            </Button>
          </div>
        ) : (
          <>
            <div className="space-y-4 py-2">
              <div className="rounded-lg bg-muted p-3 text-sm">
                <span className="text-muted-foreground">Current Balance: </span>
                <span className="font-heading font-bold">KES {currentBalance.toLocaleString()}</span>
              </div>
              <div className="space-y-2">
                <Label htmlFor="phone">M-Pesa Phone Number</Label>
                <Input
                  id="phone"
                  type="tel"
                  placeholder="e.g. 0712345678"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="amount">Amount (KES)</Label>
                <Input
                  id="amount"
                  type="number"
                  min="1"
                  max="150000"
                  placeholder="e.g. 5000"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
              {numAmount > 0 && (
                <div className="rounded-lg border border-border p-3 space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Deposit Amount</span>
                    <span>KES {numAmount.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between font-bold border-t border-border pt-1 mt-1">
                    <span>New Balance</span>
                    <span>KES {(currentBalance + numAmount).toLocaleString()}</span>
                  </div>
                </div>
              )}
              <div className="flex items-center gap-2 rounded-lg bg-primary/5 p-3 text-sm text-muted-foreground">
                <Smartphone className="h-4 w-4 text-primary flex-shrink-0" />
                <span>You'll receive an M-Pesa STK push to confirm payment. Balance updates automatically.</span>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => handleClose(false)}>Cancel</Button>
              <Button
                variant="hero"
                onClick={handleDeposit}
                disabled={loading || !amount || Number(amount) <= 0 || !phone}
              >
                {loading ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Sending…</> : "Deposit via M-Pesa"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default AddFundsDialog;
