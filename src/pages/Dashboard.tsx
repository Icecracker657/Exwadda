import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, ArrowUpRight, Wallet, Clock, CheckCircle, AlertTriangle, ArrowDownToLine } from "lucide-react";
import TransactionStatusBadge from "@/components/TransactionStatusBadge";
import AddFundsDialog from "@/components/AddFundsDialog";
import WithdrawFundsDialog from "@/components/WithdrawFundsDialog";
import EditProfileDialog from "@/components/EditProfileDialog";
import AvatarDropdown from "@/components/AvatarDropdown";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

interface Transaction {
  id: string;
  title: string;
  counterparty_email: string;
  amount: number;
  status: string;
  created_at: string;
  description: string | null;
}

interface PendingWithdrawal {
  id: string;
  amount: number;
  phone: string;
  created_at: string;
}

const Dashboard = () => {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [balance, setBalance] = useState(0);
  const [profile, setProfile] = useState<{ first_name: string; last_name: string; phone?: string | null; email?: string | null } | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [pendingWithdrawals, setPendingWithdrawals] = useState<PendingWithdrawal[]>([]);
  const [addFundsOpen, setAddFundsOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [editProfileOpen, setEditProfileOpen] = useState(false);

  const fetchData = async () => {
    if (!user) return;
    const [walletRes, profileRes, txRes, withdrawRes] = await Promise.all([
      supabase.from("wallets").select("balance").eq("user_id", user.id).single(),
      supabase.from("profiles").select("first_name, last_name, phone, email").eq("user_id", user.id).single(),
      supabase.from("transactions").select("id, title, counterparty_email, amount, status, created_at, description").order("created_at", { ascending: false }).limit(10),
      supabase.from("wallet_transactions").select("id, amount, phone, created_at").eq("user_id", user.id).eq("type", "withdrawal_pending").order("created_at", { ascending: false }),
    ]);
    if (walletRes.data) setBalance(Number(walletRes.data.balance));
    if (profileRes.data) setProfile(profileRes.data);
    if (txRes.data) setTransactions(txRes.data as Transaction[]);
    if (withdrawRes.data) setPendingWithdrawals(withdrawRes.data as PendingWithdrawal[]);
  };

  useEffect(() => { fetchData(); }, [user]);

  const initials = profile ? `${profile.first_name?.[0] || ""}${profile.last_name?.[0] || ""}`.toUpperCase() : "??";

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  const activeCount = transactions.filter(t => ["pending_approval", "approved", "funded", "delivered"].includes(t.status)).length;
  const completedCount = transactions.filter(t => ["released", "accepted"].includes(t.status)).length;
  const disputedCount = transactions.filter(t => t.status === "disputed").length;

  const stats = [
    { label: "Wallet Balance", value: `KES ${balance.toLocaleString()}`, icon: Wallet, color: "text-primary", action: () => setAddFundsOpen(true) },
    { label: "Active", value: String(activeCount), icon: Clock, color: "text-kenya-gold" },
    { label: "Completed", value: String(completedCount), icon: CheckCircle, color: "text-primary" },
    { label: "Disputed", value: String(disputedCount), icon: AlertTriangle, color: "text-accent" },
  ];

  return (
    <div className="min-h-screen bg-muted">
      <header className="border-b border-border bg-card">
        <div className="container mx-auto flex h-16 items-center justify-between px-4">
          <Link to="/" className="flex items-center gap-2">
            <img src="/exwadda-icon.png" alt="ExWadda" className="h-6 w-6" />
            <span className="font-heading text-lg font-bold">ExWadda</span>
          </Link>
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={() => setWithdrawOpen(true)} className="gap-1">
              <ArrowDownToLine className="h-4 w-4" /> Withdraw
            </Button>
            <Button variant="outline" size="sm" onClick={() => setAddFundsOpen(true)} className="gap-1">
              <Wallet className="h-4 w-4" /> Add Funds
            </Button>
            <Link to="/dashboard/create">
              <Button variant="hero" size="sm" className="gap-1">
                <Plus className="h-4 w-4" /> New Transaction
              </Button>
            </Link>
            <AvatarDropdown
              initials={initials}
              profile={profile}
              onEditProfile={() => setEditProfileOpen(true)}
              onSignOut={handleSignOut}
            />
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        <h1 className="mb-6 font-heading text-2xl font-bold">
          Welcome{profile ? `, ${profile.first_name}` : ""}
        </h1>

        <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {stats.map((s) => (
            <Card key={s.label} className={s.action ? "cursor-pointer hover:border-primary/50 transition-colors" : ""} onClick={s.action}>
              <CardContent className="flex items-center gap-4 p-5">
                <div className={`flex h-11 w-11 items-center justify-center rounded-lg bg-muted ${s.color}`}>
                  <s.icon className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">{s.label}</p>
                  <p className="font-heading text-xl font-bold">{s.value}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Pending Withdrawals */}
        {pendingWithdrawals.length > 0 && (
          <Card className="mb-6 border-amber-200 bg-amber-50">
            <CardHeader className="pb-3">
              <CardTitle className="font-heading text-base flex items-center gap-2 text-amber-800">
                <Clock className="h-4 w-4" />
                Pending Withdrawals
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {pendingWithdrawals.map((w) => (
                <div key={w.id} className="flex items-center justify-between rounded-lg bg-white border border-amber-200 p-3 text-sm">
                  <div>
                    <p className="font-medium text-amber-900">KES {Number(w.amount).toLocaleString()} → {w.phone}</p>
                    <p className="text-xs text-amber-700 mt-0.5">Requested {new Date(w.created_at).toLocaleString("en-KE", { timeZone: "Africa/Nairobi" })}</p>
                  </div>
                  <Badge className="bg-amber-100 text-amber-800 border-amber-300 hover:bg-amber-100">
                    Pending Payment
                  </Badge>
                </div>
              ))}
              <p className="text-xs text-amber-700 pt-1">Your withdrawal will be processed within 24 hours. You'll receive an email confirmation once paid.</p>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="font-heading text-lg">Recent Transactions</CardTitle>
            <Button variant="ghost" size="sm" className="text-primary gap-1">View All <ArrowUpRight className="h-3 w-3" /></Button>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {transactions.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">No transactions yet. Create your first one!</p>
              ) : transactions.map((tx) => (
                <Link
                  key={tx.id}
                  to={`/dashboard/transaction/${tx.id}`}
                  className="flex items-center justify-between rounded-lg border border-border p-4 transition-colors hover:bg-muted/50"
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-3">
                      <span className="font-heading font-semibold">{tx.title}</span>
                      <TransactionStatusBadge status={tx.status as any} />
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{tx.counterparty_email}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-heading font-bold">KES {Number(tx.amount).toLocaleString()}</p>
                    <p className="text-xs text-muted-foreground">{new Date(tx.created_at).toLocaleDateString()}</p>
                  </div>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      </main>

      <AddFundsDialog open={addFundsOpen} onOpenChange={setAddFundsOpen} currentBalance={balance} onSuccess={fetchData} />
      <WithdrawFundsDialog open={withdrawOpen} onOpenChange={setWithdrawOpen} currentBalance={balance} onSuccess={fetchData} />
      <EditProfileDialog open={editProfileOpen} onOpenChange={setEditProfileOpen} profile={profile} onSuccess={fetchData} />
    </div>
  );
};

export default Dashboard;
