import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "@/hooks/use-toast";
import { Smartphone, AlertCircle } from "lucide-react";

interface WithdrawFundsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentBalance: number;
  onSuccess: () => void;
}

const MIN_WITHDRAWAL = 10;

const WithdrawFundsDialog = ({ open, onOpenChange, currentBalance, onSuccess }: WithdrawFundsDialogProps) => {
  const { user } = useAuth();
  const [amount, setAmount] = useState("");
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);

  const numAmount = Number(amount) || 0;
  const isBelowMin = numAmount > 0 && numAmount < MIN_WITHDRAWAL;
  const isAboveBalance = numAmount > currentBalance;
  const isValid = numAmount >= MIN_WITHDRAWAL && numAmount <= currentBalance && phone.trim().length > 0;

  const handleWithdraw = async () => {
    if (!user) return;
    if (numAmount < MIN_WITHDRAWAL) {
      toast({ title: "Amount too low", description: `Minimum withdrawal is KES ${MIN_WITHDRAWAL}.`, variant: "destructive" });
      return;
    }
    if (numAmount > currentBalance) {
      toast({ title: "Insufficient balance", description: "You cannot withdraw more than your wallet balance.", variant: "destructive" });
      return;
    }
    if (!phone.trim()) {
      toast({ title: "Phone required", description: "Please enter your M-Pesa phone number.", variant: "destructive" });
      return;
    }
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("withdraw-funds", {
        body: { amount: numAmount, phone },
      });
      if (error || data?.error) throw new Error(data?.error || error?.message);
      toast({ title: "Withdrawal initiated!", description: data.message || `KES ${numAmount.toLocaleString()} withdrawal is being processed.` });
      setAmount("");
      setPhone("");
      onOpenChange(false);
      onSuccess();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-heading">Withdraw Funds</DialogTitle>
          <DialogDescription>Withdraw money from your ExWadda wallet to M-Pesa.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="rounded-lg bg-muted p-3 text-sm">
            <span className="text-muted-foreground">Available Balance:</span>{" "}
            <span className="font-heading font-bold">KES {currentBalance.toLocaleString()}</span>
          </div>
          <div className="space-y-2">
            <Label htmlFor="withdraw-amount">Amount (KES)</Label>
            <Input
              id="withdraw-amount"
              type="number"
              min="10"
              max={currentBalance}
              placeholder="Minimum KES 10"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className={isBelowMin || isAboveBalance ? "border-destructive" : ""}
            />
            {isBelowMin && (
              <div className="flex items-center gap-1 text-xs text-destructive">
                <AlertCircle className="h-3 w-3" />
                Minimum withdrawal is KES {MIN_WITHDRAWAL}
              </div>
            )}
            {isAboveBalance && numAmount > 0 && (
              <div className="flex items-center gap-1 text-xs text-destructive">
                <AlertCircle className="h-3 w-3" />
                Amount exceeds your balance of KES {currentBalance.toLocaleString()}
              </div>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="withdraw-phone">M-Pesa phone number</Label>
            <Input
              id="withdraw-phone"
              type="tel"
              placeholder="07XXXXXXXX"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          {numAmount >= MIN_WITHDRAWAL && numAmount <= currentBalance && (
            <div className="rounded-lg border border-border p-3 space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Withdrawal amount</span>
                <span>KES {numAmount.toLocaleString()}</span>
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>New Balance</span>
                <span>KES {(currentBalance - numAmount).toLocaleString()}</span>
              </div>
            </div>
          )}
          <div className="flex items-center gap-2 rounded-lg bg-primary/5 p-3 text-sm text-muted-foreground">
            <Smartphone className="h-4 w-4 text-primary" />
            <span>Funds will be sent to your M-Pesa account within 24 hours of your request.</span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="hero" onClick={handleWithdraw} disabled={loading || !isValid}>
            {loading ? "Processing…" : "Withdraw to M-Pesa"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default WithdrawFundsDialog;
