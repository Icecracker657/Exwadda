import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, Calculator } from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";

// Platform fee is now 3% — enforced on backend too
const COMMISSION_RATE = 0.03;

const CATEGORIES = [
  "Electronics",
  "Vehicles & Auto Parts",
  "Real Estate",
  "Furniture & Home",
  "Fashion & Clothing",
  "Agriculture & Livestock",
  "Web & Software Development",
  "Graphic Design & Creative",
  "Consulting & Professional Services",
  "Construction & Engineering",
  "Freelancing & Gig Work",
  "Documentation & Legal",
  "Digital Products & Downloads",
  "General Merchandise",
  "Other",
];

const CreateTransaction = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);

  const [role, setRole] = useState("buyer");
  const [counterpartyEmail, setCounterpartyEmail] = useState("");
  const [counterpartyPhone, setCounterpartyPhone] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [amount, setAmount] = useState("");
  const [feePayer, setFeePayer] = useState("buyer");
  const [deadline, setDeadline] = useState("");
  const [brokerCommission, setBrokerCommission] = useState("");
  const [sellerEmail, setSellerEmail] = useState("");
  const [sellerPhone, setSellerPhone] = useState("");
  const [buyerEmail, setBuyerEmail] = useState("");
  const [buyerPhone, setBuyerPhone] = useState("");

  const numAmount = parseFloat(amount) || 0;
  const fee = Math.round(numAmount * COMMISSION_RATE);
  const total = numAmount + fee;
  const brokerFee = role === "broker" ? Math.round(numAmount * (parseFloat(brokerCommission) || 0) / 100) : 0;
  const buyerTotal = feePayer === "buyer" ? total : feePayer === "split" ? numAmount + Math.round(fee / 2) : numAmount;
  const sellerReceives = feePayer === "seller" ? numAmount - fee - brokerFee : feePayer === "split" ? numAmount - Math.round(fee / 2) - brokerFee : numAmount - brokerFee;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    if (role === "broker") {
      if (!buyerEmail || !sellerEmail || !title || !category || numAmount <= 0) {
        toast({ title: "Missing fields", description: "Please fill in buyer email, seller email, title, category, and amount.", variant: "destructive" });
        return;
      }
    } else {
      if (!counterpartyEmail || !title || !category || numAmount <= 0) {
        toast({ title: "Missing fields", description: "Please fill in all required fields.", variant: "destructive" });
        return;
      }
    }

    setLoading(true);
    try {
      // All transaction creation goes through the secure backend edge function
      const { data, error } = await supabase.functions.invoke("create-transaction", {
        body: {
          role,
          counterpartyEmail,
          counterpartyPhone,
          buyerEmail,
          buyerPhone,
          sellerEmail,
          sellerPhone,
          brokerEmail: role === "broker" ? user.email : null,
          title,
          description,
          category,
          amount: numAmount,
          feePayer,
          deadline,
          brokerCommission: parseFloat(brokerCommission) || 0,
        },
      });

      if (error || data?.error) {
        throw new Error(data?.error || error?.message || "Failed to create transaction");
      }

      toast({
        title: "Transaction created!",
        description: "An approval request has been emailed to your counterparty.",
      });
      navigate("/dashboard");
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-muted">
      <header className="border-b border-border bg-card">
        <div className="container mx-auto flex h-16 items-center gap-4 px-4">
          <Link to="/dashboard" className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="h-4 w-4" /> Back
          </Link>
          <div className="flex items-center gap-2">
            <img src="/exwadda-icon.png" alt="ExWadda" className="h-8 w-8" />
            <span className="font-heading font-bold">New Transaction</span>
          </div>
        </div>
      </header>

      <main className="container mx-auto max-w-2xl px-4 py-8">
        <Card>
          <CardHeader>
            <CardTitle className="font-heading text-xl">Create ExWadda Transaction</CardTitle>
            <CardDescription>
              Set up a secure escrow transaction. Your counterparty will receive an email to approve.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-5" onSubmit={handleSubmit}>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Your role</Label>
                  <Select value={role} onValueChange={setRole}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="buyer">I'm the Buyer</SelectItem>
                      <SelectItem value="seller">I'm the Seller</SelectItem>
                      <SelectItem value="broker">I'm the Broker</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Category *</Label>
                  <Select value={category} onValueChange={setCategory}>
                    <SelectTrigger><SelectValue placeholder="Select category" /></SelectTrigger>
                    <SelectContent>
                      {CATEGORIES.map((cat) => (
                        <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {role === "broker" ? (
                <>
                  <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm text-muted-foreground">
                    As a broker, you mediate between buyer and seller. Enter both parties' details below.
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Buyer email *</Label>
                      <Input type="email" placeholder="buyer@example.com" value={buyerEmail} onChange={(e) => setBuyerEmail(e.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label>Buyer phone</Label>
                      <Input type="tel" placeholder="+254 7XX XXX XXX" value={buyerPhone} onChange={(e) => setBuyerPhone(e.target.value)} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Seller email *</Label>
                      <Input type="email" placeholder="seller@example.com" value={sellerEmail} onChange={(e) => setSellerEmail(e.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label>Seller phone</Label>
                      <Input type="tel" placeholder="+254 7XX XXX XXX" value={sellerPhone} onChange={(e) => setSellerPhone(e.target.value)} />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>Your broker commission (%)</Label>
                    <Input type="number" min="0" max="50" step="0.5" placeholder="e.g. 5" value={brokerCommission} onChange={(e) => setBrokerCommission(e.target.value)} />
                  </div>
                </>
              ) : (
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Counterparty email *</Label>
                    <Input type="email" placeholder="partner@example.com" value={counterpartyEmail} onChange={(e) => setCounterpartyEmail(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label>Counterparty phone</Label>
                    <Input type="tel" placeholder="+254 7XX XXX XXX" value={counterpartyPhone} onChange={(e) => setCounterpartyPhone(e.target.value)} />
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <Label>Transaction title *</Label>
                <Input placeholder="e.g., Website Development Project" value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>

              <div className="space-y-2">
                <Label>Description & delivery terms</Label>
                <Textarea placeholder="Describe what's being exchanged and the delivery conditions..." rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Amount (KES) *</Label>
                  <Input type="number" placeholder="0.00" min="1" value={amount} onChange={(e) => setAmount(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>Who pays the platform fee?</Label>
                  <Select value={feePayer} onValueChange={setFeePayer}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="buyer">Buyer pays (3%)</SelectItem>
                      <SelectItem value="seller">Seller pays (3%)</SelectItem>
                      <SelectItem value="split">Split 50/50</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Delivery deadline</Label>
                <Input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} min={new Date().toISOString().split("T")[0]} />
              </div>

              {numAmount > 0 && (
                <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <Calculator className="h-4 w-4 text-primary" />
                    <span className="font-heading text-sm font-semibold">Fee Breakdown</span>
                  </div>
                  <div className="space-y-1.5 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Transaction amount</span>
                      <span>KES {numAmount.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Platform fee (3%)</span>
                      <span>KES {fee.toLocaleString()}</span>
                    </div>
                    {role === "broker" && parseFloat(brokerCommission) > 0 && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Broker commission ({brokerCommission}%)</span>
                        <span>KES {brokerFee.toLocaleString()}</span>
                      </div>
                    )}
                    <div className="border-t border-border/50 pt-1.5 mt-1.5 space-y-1">
                      <div className="flex justify-between font-medium">
                        <span>Buyer pays total</span>
                        <span className="text-primary">KES {buyerTotal.toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between text-muted-foreground">
                        <span>Seller receives</span>
                        <span>KES {sellerReceives.toLocaleString()}</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <Button variant="hero" className="w-full" type="submit" disabled={loading}>
                {loading ? "Creating & Sending Approval…" : "Create & Send Approval Request"}
              </Button>

              <p className="text-center text-xs text-muted-foreground">
                Your counterparty will receive an email with an approval link. Funds are only deducted upon approval.
              </p>
            </form>
          </CardContent>
        </Card>
      </main>
    </div>
  );
};

export default CreateTransaction;
