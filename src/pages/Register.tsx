import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Eye, EyeOff, Mail, CheckCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";

type Step = "details" | "otp";

const Register = () => {
  const [step, setStep] = useState<Step>("details");
  const [showPw, setShowPw] = useState(false);
  const [role, setRole] = useState("both");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const navigate = useNavigate();

  // Step 1: Send OTP to email
  const handleSendOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName || !email || !password) {
      toast({ title: "Missing fields", description: "Please fill in all required fields.", variant: "destructive" });
      return;
    }
    if (password.length < 8) {
      toast({ title: "Weak password", description: "Password must be at least 8 characters.", variant: "destructive" });
      return;
    }

    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("send-otp", {
        // Password is sent here so it can be saved in pending_registrations
        // and used by verify-otp to create the auth user.
        body: { email, first_name: firstName, last_name: lastName, phone, role, password },
      });

      if (error || data?.error) {
        throw new Error(data?.error || error?.message || "Failed to send OTP");
      }

      toast({
        title: "Verification code sent!",
        description: `We sent a 6-digit code to ${email}. Check your inbox.`,
      });
      setStep("otp");
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  // Step 2: Verify OTP and complete registration
  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!otp || otp.length !== 6) {
      toast({ title: "Invalid OTP", description: "Please enter the 6-digit code from your email.", variant: "destructive" });
      return;
    }

    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("verify-otp", {
        body: { email, otp, password },
      });

      if (error || data?.error) {
        throw new Error(data?.error || error?.message || "Verification failed");
      }

      if (data?.requireLogin) {
        toast({ title: "Account created!", description: "Please log in with your credentials." });
        navigate("/login");
        return;
      }

      // If session returned, set it
      if (data?.session) {
        await supabase.auth.setSession({
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
        });
      }

      toast({ title: "Account activated! 🎉", description: "Welcome to ExWadda." });
      navigate("/dashboard");
    } catch (err: any) {
      toast({ title: "Verification failed", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleResendOtp = async () => {
    setResending(true);
    try {
      const { data, error } = await supabase.functions.invoke("send-otp", {
        body: { email, first_name: firstName, last_name: lastName, phone, role, password },
      });
      if (error || data?.error) throw new Error(data?.error || "Failed to resend");
      toast({ title: "Code resent!", description: `A new code was sent to ${email}.` });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <Link to="/" className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <img src="/exwadda-icon.png" alt="ExWadda" className="h-8 w-8" />
          </Link>
          {step === "details" ? (
            <>
              <CardTitle className="font-heading text-2xl">Create your account</CardTitle>
              <CardDescription>create account to start transacting securely</CardDescription>
            </>
          ) : (
            <>
              <CardTitle className="font-heading text-2xl">Verify your email</CardTitle>
              <CardDescription>
                Enter the 6-digit code sent to <strong>{email}</strong>
              </CardDescription>
            </>
          )}
        </CardHeader>

        <CardContent>
          {step === "details" ? (
            <form className="space-y-4" onSubmit={handleSendOtp}>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="firstName">First name *</Label>
                  <Input id="firstName" placeholder="John" value={firstName} onChange={(e) => setFirstName(e.target.value)} required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lastName">Last name</Label>
                  <Input id="lastName" placeholder="Kamau" value={lastName} onChange={(e) => setLastName(e.target.value)} />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="email">Email *</Label>
                <Input id="email" type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>

              <div className="space-y-2">
                <Label htmlFor="phone">Phone (optional)</Label>
                <Input id="phone" type="tel" placeholder="+254 7XX XXX XXX" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">Password *</Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPw ? "text" : "password"}
                    placeholder="At least 8 characters"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={8}
                  />
                  <button type="button" onClick={() => setShowPw(!showPw)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                    {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div className="space-y-3">
                <Label>I want to</Label>
                <RadioGroup value={role} onValueChange={setRole} className="flex flex-wrap gap-3">
                  {[
                    { value: "buyer", label: "Buy" },
                    { value: "seller", label: "Sell" },
                    { value: "broker", label: "Broker" },
                    { value: "both", label: "All" },
                  ].map((r) => (
                    <label key={r.value} className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-4 py-2.5 text-sm transition-colors hover:border-primary/50 has-[data-state=checked]:border-primary has-[data-state=checked]:bg-primary/5">
                      <RadioGroupItem value={r.value} />
                      {r.label}
                    </label>
                  ))}
                </RadioGroup>
              </div>

              <Button variant="hero" className="w-full gap-2" type="submit" disabled={loading}>
                <Mail className="h-4 w-4" />
                {loading ? "Sending verification code…" : "Send Verification Code"}
              </Button>
            </form>
          ) : (
            <form className="space-y-6" onSubmit={handleVerifyOtp}>
              <div className="rounded-lg bg-primary/5 border border-primary/20 p-4 text-center">
                <Mail className="h-8 w-8 text-primary mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">
                  We sent a 6-digit verification code to
                </p>
                <p className="font-semibold text-foreground">{email}</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="otp">Verification Code</Label>
                <Input
                  id="otp"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  placeholder="000000"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                  className="text-center text-2xl tracking-[0.5em] font-bold"
                  required
                />
              </div>

              <Button variant="hero" className="w-full gap-2" type="submit" disabled={loading}>
                <CheckCircle className="h-4 w-4" />
                {loading ? "Verifying…" : "Verify & Activate Account"}
              </Button>

              <div className="text-center space-y-2">
                <p className="text-sm text-muted-foreground">Didn't receive the code?</p>
                <button
                  type="button"
                  onClick={handleResendOtp}
                  disabled={resending}
                  className="text-sm text-primary hover:underline font-medium disabled:opacity-50"
                >
                  {resending ? "Resending…" : "Resend code"}
                </button>
                <span className="text-muted-foreground text-sm"> · </span>
                <button
                  type="button"
                  onClick={() => setStep("details")}
                  className="text-sm text-muted-foreground hover:text-foreground"
                >
                  Change email
                </button>
              </div>
            </form>
          )}

          <p className="mt-4 text-center text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link to="/login" className="text-primary hover:underline font-medium">Log in</Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
};

export default Register;
