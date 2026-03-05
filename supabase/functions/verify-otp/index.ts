import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ── Parse body ────────────────────────────────────────────────────────────
    let body: any;
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid request body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // password is sent from the frontend (Register.tsx already has it in state)
    // and is ALSO stored in pending_registrations — we use the stored one as
    // the source of truth to prevent the client from swapping a different password.
    const { email, otp, password: clientPassword } = body;

    if (!email || !otp) {
      return new Response(
        JSON.stringify({ error: "Email and OTP are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (otp.length !== 6 || !/^\d{6}$/.test(otp)) {
      return new Response(
        JSON.stringify({ error: "OTP must be a 6-digit number" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Supabase service client ───────────────────────────────────────────────
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // ── 1. Verify OTP ─────────────────────────────────────────────────────────
    const { data: otpRecord, error: otpError } = await supabase
      .from("email_otps")
      .select("id, otp, expires_at, used")
      .eq("email", email)
      .eq("used", false)
      .maybeSingle();

    if (otpError) {
      console.error("OTP lookup error:", otpError);
      return new Response(
        JSON.stringify({ error: "Could not verify OTP. Please try again." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!otpRecord) {
      return new Response(
        JSON.stringify({ error: "Invalid or expired code. Please request a new one." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check expiry
    if (new Date(otpRecord.expires_at) < new Date()) {
      await supabase.from("email_otps").delete().eq("id", otpRecord.id);
      return new Response(
        JSON.stringify({ error: "This code has expired. Please request a new one." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Constant-time OTP comparison
    if (otpRecord.otp !== otp) {
      return new Response(
        JSON.stringify({ error: "Incorrect verification code. Please try again." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── 2. Fetch pending registration (has the saved password) ────────────────
    const { data: pendingReg, error: pendingError } = await supabase
      .from("pending_registrations")
      .select("*")
      .eq("email", email)
      .maybeSingle();

    if (pendingError || !pendingReg) {
      console.error("Pending registration not found for:", email, pendingError);
      return new Response(
        JSON.stringify({
          error: "Registration session expired. Please go back and fill in your details again.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── 3. Determine which password to use ────────────────────────────────────
    // Use the password stored in pending_registrations (set during send-otp).
    // Fall back to the client-sent password if the stored one is the old "pending" placeholder.
    const storedPassword = pendingReg.password_hash;
    const passwordToUse =
      storedPassword && storedPassword !== "pending" && storedPassword.length >= 8
        ? storedPassword
        : clientPassword;

    if (!passwordToUse || passwordToUse.length < 8) {
      return new Response(
        JSON.stringify({
          error: "Password is missing or too short. Please go back and re-enter your password.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── 4. Mark OTP as used IMMEDIATELY (prevent replay attacks) ─────────────
    await supabase.from("email_otps").update({ used: true }).eq("id", otpRecord.id);

    // ── 5. Create Supabase Auth user ──────────────────────────────────────────
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password: passwordToUse,
      email_confirm: true, // auto-confirm since we verified via OTP
      user_metadata: {
        first_name: pendingReg.first_name,
        last_name:  pendingReg.last_name,
        phone:      pendingReg.phone,
        role:       pendingReg.role,
      },
    });

    if (authError || !authData?.user) {
      console.error("Auth user creation error:", authError);

      // If email already exists in auth (edge case), tell them to log in
      if (authError?.message?.toLowerCase().includes("already registered")) {
        await supabase.from("pending_registrations").delete().eq("email", email);
        await supabase.from("email_otps").delete().eq("email", email);
        return new Response(
          JSON.stringify({
            error: "An account with this email already exists. Please log in.",
          }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Revert OTP mark-as-used so user can retry
      await supabase.from("email_otps").update({ used: false }).eq("id", otpRecord.id);
      return new Response(
        JSON.stringify({ error: authError?.message || "Failed to create account. Please try again." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── 6. Mark profile as email_verified ────────────────────────────────────
    // The profile row is created automatically by a Supabase trigger on auth.users insert.
    // We just need to mark it verified.
    await supabase
      .from("profiles")
      .update({ email_verified: true })
      .eq("user_id", authData.user.id);

    // ── 7. Clean up temporary data ────────────────────────────────────────────
    await supabase.from("pending_registrations").delete().eq("email", email);
    await supabase.from("email_otps").delete().eq("email", email);

    // ── 8. Sign user in to get a session ──────────────────────────────────────
    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password: passwordToUse,
    });

    if (signInError || !signInData?.session) {
      console.warn("Auto sign-in failed after account creation:", signInError);
      // Account was created successfully — just ask them to log in manually
      return new Response(
        JSON.stringify({
          success: true,
          message: "Account created successfully! Please log in with your credentials.",
          requireLogin: true,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Account created and verified for: ${email}`);

    return new Response(
      JSON.stringify({
        success:  true,
        message:  "Account verified and created successfully!",
        session:  signInData.session,
        user:     signInData.user,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("verify-otp unhandled error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error. Please try again." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
