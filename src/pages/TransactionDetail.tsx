import { Link, useParams } from "react-router-dom";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
   ArrowLeft, CheckCircle, AlertTriangle, Clock,
  Wallet, MessageCircle, Loader2, Package, PackageCheck, Banknote, Smartphone,
} from "lucide-react";
import TransactionStatusBadge from "@/components/TransactionStatusBadge";
import TransactionChat from "@/components/TransactionChat";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { format } from "date-fns";
import { toast } from "sonner";

const statusSteps = ["pending_approval", "approved", "funded", "delivered", "accepted", "released"] as const;

interface Transaction {
  id: string;
  title: string;
  description: string | null;
  amount: number;
  fee: number;
  total: number;
  status: string;
  category: string;
  counterparty_email: string;
  counterparty_phone: string | null;
  delivery_deadline: string | null;
  created_at: string;
  created_by: string;
  buyer_id: string | null;
  seller_id: string | null;
  broker_id: string | null;
  broker_commission: number | null;
  role_in_transaction: string;
  fee_payer: string;
  funded_at: string | null;
  approved_at: string | null;
  product_released: boolean;
  product_received: boolean;
  released_at: string | null;
  disputed_at: string | null;
  buyer_email: string | null;
  seller_email: string | null;
  buyer_phone: string | null;
  seller_phone: string | null;
  broker_email: string | null;
}

const TransactionDetail = () => {
  const { id } = useParams();
  const { user } = useAuth();
  const [transaction, setTransaction] = useState<Transaction | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [disputeReason, setDisputeReason] = useState("");
  const [showDisputeForm, setShowDisputeForm] = useState(false);
  const [showFundForm, setShowFundForm] = useState(false);
  const [fundPhone, setFundPhone] = useState("");
  const [fundLoading, setFundLoading] = useState(false);

  const fetchTransaction = async () => {
    if (!id) return;
    const { data, error } = await (supabase as any)
      .from("transactions")
      .select("*")
      .eq("id", id)
      .single();

    if (error) {
      toast.error("Failed to load transaction");
    } else {
      setTransaction(data as Transaction);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchTransaction();
    const channel = supabase
      .channel(`transaction-${id}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "transactions", filter: `id=eq.${id}` }, () => {
        fetchTransaction();
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [id]);

  // Pre-fill phone from user profile
  useEffect(() => {
    if (user && !fundPhone) {
      supabase.from("profiles").select("phone").eq("user_id", user.id).single().then(({ data }) => {
        if (data?.phone) setFundPhone(data.phone);
      });
    }
  }, [user]);

  const isBuyer = user?.id === transaction?.buyer_id;
  const isSeller = user?.id === transaction?.seller_id;
  const isBroker = user?.id === transaction?.broker_id;
  const isCreator = user?.id === transaction?.created_by;
  const isParticipant = isBuyer || isSeller || isBroker || isCreator;

  // Fund transaction via M-Pesa STK push
  const handleFundTransaction = async () => {
    if (!transaction || !user) return;
    if (!fundPhone.trim()) {
      toast.error("Please enter your M-Pesa phone number.");
      return;
    }
    setFundLoading(true);
    try {
      const buyerTotal = transaction.fee_payer === "buyer"
        ? transaction.total
        : transaction.fee_payer === "split"
        ? transaction.amount + Math.round(transaction.fee / 2)
        : transaction.amount;

      const { data, error } = await supabase.functions.invoke("daraja-stk-push", {
        body: { phone: fundPhone, amount: buyerTotal },
      });

      if (error || data?.error) throw new Error(data?.error || error?.message);

      toast.success("M-Pesa payment request sent! Enter your PIN when prompted on your phone.");
      setShowFundForm(false);
    } catch (err: any) {
      toast.error(err.message || "Failed to initiate M-Pesa payment");
    } finally {
      setFundLoading(false);
    }
  };

  const handleRaiseDispute = async () => {
    if (!transaction || !user) return;
    if (!disputeReason.trim()) {
      toast.error("Please provide a reason for the dispute.");
      return;
    }
    setActionLoading(true);
    try {
      const { error } = await supabase.rpc("raise_dispute", {
        _transaction_id: transaction.id,
        _reason: disputeReason.trim(),
      });
      if (error) throw error;
      await supabase.functions.invoke("send-transaction-email", {
        body: { transaction_id: transaction.id, event: "disputed" },
      });
      toast.success("Dispute raised. The Exawadda support team will review and contact both parties.");
      setShowDisputeForm(false);
      fetchTransaction();
    } catch (err: any) {
      toast.error(err.message || "Failed to raise dispute");
    } finally {
      setActionLoading(false);
    }
  };

  const handleMarkReleased = async () => {
    if (!transaction) return;
    setActionLoading(true);
    try {
      const { error } = await supabase.rpc("mark_product_released", { _transaction_id: transaction.id });
      if (error) throw error;
      toast.success("Product/service marked as released. The buyer has been notified.");
      fetchTransaction();
    } catch (err: any) {
      toast.error(err.message || "Failed to mark as released");
    } finally {
      setActionLoading(false);
    }
  };

  const handleMarkReceived = async () => {
    if (!transaction) return;
    setActionLoading(true);
    try {
      const { error } = await supabase.rpc("mark_product_received", { _transaction_id: transaction.id });
      if (error) throw error;
      toast.success("Received checked and confirmed. You can now release the funds to the seller.");
      fetchTransaction();
    } catch (err: any) {
      toast.error(err.message || "Failed to confirm product/services received");
    } finally {
      setActionLoading(false);
    }
  };

  const handleReleaseFunds = async () => {
    if (!transaction) return;
    setActionLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("release-funds", {
        body: { transaction_id: transaction.id },
      });
      if (error || data?.error) throw new Error(data?.error || error?.message);
      await supabase.functions.invoke("send-transaction-email", {
        body: { transaction_id: transaction.id, event: "released" },
      });
      toast.success(`Funds released! The seller has been credited KES ${data.sellerPayout?.toLocaleString()}.`);
      fetchTransaction();
    } catch (err: any) {
      toast.error(err.message || "Failed to release funds");
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-muted flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!transaction) {
    return (
      <div className="min-h-screen bg-muted flex flex-col items-center justify-center gap-4">
        <p className="text-muted-foreground">Transaction not found.</p>
        <Link to="/dashboard"><Button variant="outline">Back to Dashboard</Button></Link>
      </div>
    );
  }

  const currentStepIndex = statusSteps.indexOf(transaction.status as any);
  const stepLabels: Record<string, string> = {
    pending_approval: "Pending",
    approved: "Approved",
    funded: "Funded",
    delivered: "Delivered",
    accepted: "Accepted",
    released: "Complete",
  };

  const buyerTotal = transaction.fee_payer === "buyer"
    ? transaction.total
    : transaction.fee_payer === "split"
    ? transaction.amount + Math.round(transaction.fee / 2)
    : transaction.amount;

  return (
    <div className="min-h-screen bg-muted">
      <header className="border-b border-border bg-card">
        <div className="container mx-auto flex h-16 items-center gap-4 px-4">
          <Link to="/dashboard" className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="h-4 w-4" /> Dashboard
          </Link>
          <div className="flex items-center gap-2">
            <img src="/exwadda-icon.png" alt="ExWadda" className="h-8 w-8" />
            <span className="font-heading font-bold">{transaction.title}</span>
          </div>
        </div>
      </header>

      <main className="container mx-auto max-w-3xl px-4 py-8 space-y-6">

        {/* Progress Tracker */}
        <Card>
          <CardHeader>
            <CardTitle className="font-heading text-lg">Transaction Progress</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center">
              {statusSteps.map((step, i) => (
                <div key={step} className="flex flex-1 items-center">
                  <div className="flex flex-col items-center">
                    <div className={`flex h-10 w-10 items-center justify-center rounded-full border-2 transition-colors ${
                      i <= currentStepIndex
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-card text-muted-foreground"
                    }`}>
                      {i <= currentStepIndex ? <CheckCircle className="h-5 w-5" /> : <Clock className="h-4 w-4" />}
                    </div>
                    <span className="mt-1 text-[10px] font-medium text-center">{stepLabels[step]}</span>
                  </div>
                  {i < statusSteps.length - 1 && (
                    <div className={`mx-1 h-0.5 flex-1 ${i < currentStepIndex ? "bg-primary" : "bg-border"}`} />
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Details */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="font-heading text-lg">Transaction Details</CardTitle>
              <TransactionStatusBadge status={transaction.status as any} />
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4 text-sm">
              {isBroker ? (
                <>
                  <div>
                    <span className="text-muted-foreground">Buyer</span>
                    <p className="font-medium">{transaction.buyer_email ?? "—"}</p>
                    {transaction.buyer_phone && <p className="text-xs text-muted-foreground">{transaction.buyer_phone}</p>}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Seller</span>
                    <p className="font-medium">{transaction.seller_email ?? "—"}</p>
                    {transaction.seller_phone && <p className="text-xs text-muted-foreground">{transaction.seller_phone}</p>}
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <span className="text-muted-foreground">
                      {isBuyer ? "Seller" : isSeller ? "Buyer" : "Counterparty"}
                    </span>
                    <p className="font-medium">{transaction.counterparty_email}</p>
                    {transaction.counterparty_phone && <p className="text-xs text-muted-foreground">{transaction.counterparty_phone}</p>}
                  </div>
                  {transaction.broker_id && (
                    <div>
                      <span className="text-muted-foreground">Broker</span>
                      <p className="font-medium">{transaction.broker_email ?? "Broker"}</p>
                    </div>
                  )}
                </>
              )}
              <div>
                <span className="text-muted-foreground">Amount</span>
                <p className="font-heading font-bold text-lg">KES {Number(transaction.amount).toLocaleString()}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Platform fee (3%)</span>
                <p className="font-medium">KES {Number(transaction.fee).toLocaleString()} (paid by {transaction.fee_payer})</p>
              </div>
              <div>
                <span className="text-muted-foreground">Total</span>
                <p className="font-heading font-bold">KES {Number(transaction.total).toLocaleString()}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Category</span>
                <p className="font-medium capitalize">{transaction.category}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Deadline</span>
                <p className="font-medium">
                  {transaction.delivery_deadline ? format(new Date(transaction.delivery_deadline), "MMM d, yyyy") : "Not set"}
                </p>
              </div>
              {transaction.broker_commission != null && Number(transaction.broker_commission) > 0 && (
                <div>
                  <span className="text-muted-foreground">Broker Commission</span>
                  <p className="font-medium">KES {Number(transaction.broker_commission).toLocaleString()}</p>
                </div>
              )}
              <div>
                <span className="text-muted-foreground">Created</span>
                <p className="font-medium">{format(new Date(transaction.created_at), "MMM d, yyyy")}</p>
              </div>
            </div>
            {transaction.description && (
              <div className="text-sm">
                <span className="text-muted-foreground">Description</span>
                <p className="mt-1 font-medium">{transaction.description}</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Action Panel */}
        {isParticipant && transaction.status !== "released" && transaction.status !== "cancelled" && (
          <Card>
            <CardHeader>
              <CardTitle className="font-heading text-lg">Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">

              {/* BUYER: Fund transaction via M-Pesa (approved but not funded) */}
              {isBuyer && transaction.status === "approved" && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-3">
                  <div className="flex items-center gap-3">
                    <Smartphone className="h-5 w-5 text-amber-600" />
                    <div>
                      <p className="font-medium text-amber-800">Fund Your Transaction</p>
                      <p className="text-sm text-amber-700">
                        This transaction is approved but needs KES {buyerTotal.toLocaleString()} to be funded into escrow via M-Pesa.
                      </p>
                    </div>
                  </div>
                  {!showFundForm ? (
                    <Button
                      onClick={() => setShowFundForm(true)}
                      className="gap-2 bg-amber-600 hover:bg-amber-700 text-white"
                    >
                      <Smartphone className="h-4 w-4" />
                      Fund via M-Pesa (KES {buyerTotal.toLocaleString()})
                    </Button>
                  ) : (
                    <div className="space-y-3">
                      <div className="space-y-1">
                        <Label className="text-sm">M-Pesa Phone Number</Label>
                        <Input
                          type="tel"
                          placeholder="07XXXXXXXX"
                          value={fundPhone}
                          onChange={(e) => setFundPhone(e.target.value)}
                        />
                        <p className="text-xs text-muted-foreground">You will receive an STK push to enter your PIN.</p>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          onClick={handleFundTransaction}
                          disabled={fundLoading || !fundPhone.trim()}
                          className="gap-2 bg-amber-600 hover:bg-amber-700 text-white"
                        >
                          <Smartphone className="h-4 w-4" />
                          {fundLoading ? "Sending request…" : `Pay KES ${buyerTotal.toLocaleString()}`}
                        </Button>
                        <Button variant="outline" onClick={() => setShowFundForm(false)}>Cancel</Button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Seller: Mark product released */}
              {isSeller && transaction.status === "funded" && !transaction.product_released && (
                <div className="rounded-lg border border-border p-4 space-y-3">
                  <div className="flex items-center gap-3">
                    <Package className="h-5 w-5 text-primary" />
                    <div>
                      <p className="font-medium">Release Product or Service</p>
                      <p className="text-sm text-muted-foreground">Confirm you've released the product/service to the buyer.</p>
                    </div>
                  </div>
                  <Button onClick={handleMarkReleased} disabled={actionLoading} className="gap-2">
                    <Package className="h-4 w-4" />
                    {actionLoading ? "Processing…" : "Mark as Released"}
                  </Button>
                </div>
              )}

              {/* Buyer: Confirm received product/service */}
              {isBuyer && transaction.status === "delivered" && transaction.product_released && !transaction.product_received && (
                <div className="rounded-lg border border-border p-4 space-y-3">
                  <div className="flex items-center gap-3">
                    <PackageCheck className="h-5 w-5 text-primary" />
                    <div>
                      <p className="font-medium">Confirm Product/service recived</p>
                      <p className="text-sm text-muted-foreground">Confirm you've received and verified the product/service.</p>
                    </div>
                  </div>
                  <Button onClick={handleMarkReceived} disabled={actionLoading} className="gap-2">
                    <PackageCheck className="h-4 w-4" />
                    {actionLoading ? "Processing…" : "Confirm Receipt"}
                  </Button>
                </div>
              )}

              {/* Buyer: Release funds */}
              {isBuyer && transaction.status === "accepted" && transaction.product_received && (
                <div className="rounded-lg border border-green-200 bg-green-50 p-4 space-y-3">
                  <div className="flex items-center gap-3">
                    <Banknote className="h-5 w-5 text-green-600" />
                    <div>
                      <p className="font-medium text-green-800">Release Held Funds</p>
                      <p className="text-sm text-green-700">You've confirmed receipt. Release the funds to the seller to complete this transaction.</p>
                    </div>
                  </div>
                  <Button onClick={handleReleaseFunds} disabled={actionLoading} variant="hero" className="gap-2">
                    <Banknote className="h-4 w-4" />
                    {actionLoading ? "Releasing…" : "Release Funds to Seller"}
                  </Button>
                </div>
              )}

              {/* Status indicators */}
              {transaction.product_released && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <CheckCircle className="h-4 w-4 text-primary" />
                  Seller has marked product/service as released
                </div>
              )}
              {transaction.product_received && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <CheckCircle className="h-4 w-4 text-primary" />
                  Buyer has confirmed product/service received
                </div>
              )}

              {/* Dispute section */}
              {transaction.status !== "disputed" && transaction.status !== "released" && (
                <div className="border-t pt-4">
                  {!showDisputeForm ? (
                    <Button
                      variant="outline"
                      className="gap-2 text-destructive border-destructive/30 hover:bg-destructive/5"
                      onClick={() => setShowDisputeForm(true)}
                    >
                      <AlertTriangle className="h-4 w-4" />
                      Raise a Dispute
                    </Button>
                  ) : (
                    <div className="space-y-3">
                      <p className="font-medium text-sm">Describe the issue:</p>
                      <Textarea
                        value={disputeReason}
                        onChange={(e) => setDisputeReason(e.target.value)}
                        placeholder="Explain why you're raising a dispute..."
                        rows={3}
                      />
                      <div className="flex gap-2">
                        <Button
                          variant="destructive"
                          onClick={handleRaiseDispute}
                          disabled={actionLoading || !disputeReason.trim()}
                          className="gap-2"
                        >
                          <AlertTriangle className="h-4 w-4" />
                          {actionLoading ? "Raising…" : "Submit Dispute"}
                        </Button>
                        <Button variant="outline" onClick={() => { setShowDisputeForm(false); setDisputeReason(""); }}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {transaction.status === "disputed" && (
                <div className="flex items-center gap-2 rounded-lg bg-destructive/10 text-destructive p-3 text-sm">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  This transaction is under dispute. The exwadda support team will contact all parties to resolve the issue.
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Chat */}
        {isParticipant && (
          <Card>
            <CardHeader>
              <CardTitle className="font-heading text-lg flex items-center gap-2">
                <MessageCircle className="h-5 w-5 text-primary" /> Transaction Chat
              </CardTitle>
              <p className="text-sm text-muted-foreground">Messages are only visible to transaction participants.</p>
            </CardHeader>
            <CardContent>
              <TransactionChat transactionId={transaction.id} />
            </CardContent>
          </Card>
        )}

        {/* Activity Log */}
        <Card>
          <CardHeader>
            <CardTitle className="font-heading text-lg">Activity Log</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <Clock className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-sm font-medium">Transaction created</p>
                  <p className="text-xs text-muted-foreground">{format(new Date(transaction.created_at), "MMM d, h:mm a")}</p>
                </div>
              </div>
              {transaction.approved_at && (
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <CheckCircle className="h-4 w-4" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">Transaction approved</p>
                    <p className="text-xs text-muted-foreground">{format(new Date(transaction.approved_at), "MMM d, h:mm a")}</p>
                  </div>
                </div>
              )}
              {transaction.funded_at && (
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <Wallet className="h-4 w-4" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">Funds held by Exwadda </p>
                    <p className="text-xs text-muted-foreground">{format(new Date(transaction.funded_at), "MMM d, h:mm a")}</p>
                  </div>
                </div>
              )}
              {transaction.product_released && (
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <Package className="h-4 w-4" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">Product/service released by seller</p>
                  </div>
                </div>
              )}
              {transaction.product_received && (
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <PackageCheck className="h-4 w-4" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">Product/services received and confirmed by buyer</p>
                  </div>
                </div>
              )}
              {transaction.released_at && (
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <Banknote className="h-4 w-4" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">Funds released to seller</p>
                    <p className="text-xs text-muted-foreground">{format(new Date(transaction.released_at), "MMM d, h:mm a")}</p>
                  </div>
                </div>
              )}
              {transaction.disputed_at && (
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                    <AlertTriangle className="h-4 w-4" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-destructive">Dispute raised</p>
                    <p className="text-xs text-muted-foreground">{format(new Date(transaction.disputed_at), "MMM d, h:mm a")}</p>
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
};

export default TransactionDetail;
