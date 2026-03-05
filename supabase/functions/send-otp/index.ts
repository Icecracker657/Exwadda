import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function generateOTP(): string {
  // Cryptographically random 6-digit OTP
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return String(100000 + (array[0] % 900000));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ── Check Resend is configured FIRST (fast-fail with clear error) ────────
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    if (!RESEND_API_KEY) {
      console.error("RESEND_API_KEY is not set in Edge Function secrets");
      return new Response(
        JSON.stringify({
          error: "Email service is not configured. Please contact support.",
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

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

    const { email, first_name, last_name, phone, role, password } = body;

    if (!email || !first_name) {
      return new Response(
        JSON.stringify({ error: "Email and first name are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return new Response(
        JSON.stringify({ error: "Invalid email address" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Validate password early (it must be sent here and saved) ─────────────
    // We need the password NOW so we can store it for verify-otp to use.
    // verify-otp calls supabase.auth.admin.createUser() which needs the password.
    if (password && password.length < 8) {
      return new Response(
        JSON.stringify({ error: "Password must be at least 8 characters" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Supabase service client ───────────────────────────────────────────────
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // ── Check email not already registered ────────────────────────────────────
    const { data: existingProfile } = await supabase
      .from("profiles")
      .select("user_id")
      .eq("email", email)
      .maybeSingle();

    if (existingProfile) {
      return new Response(
        JSON.stringify({ error: "An account with this email already exists. Please log in." }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Generate OTP ──────────────────────────────────────────────────────────
    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

    // ── Clean old OTPs for this email ─────────────────────────────────────────
    await supabase.from("email_otps").delete().eq("email", email);

    // ── Store new OTP ─────────────────────────────────────────────────────────
    const { error: otpError } = await supabase.from("email_otps").insert({
      email,
      otp,
      expires_at: expiresAt,
      used: false,
    });

    if (otpError) {
      console.error("Failed to store OTP:", otpError);
      return new Response(
        JSON.stringify({ error: "Failed to generate verification code. Please try again." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Store pending registration WITH the password ──────────────────────────
    // IMPORTANT: password is stored here (not hashed — Supabase auth.admin.createUser
    // handles hashing). It is deleted immediately after verify-otp succeeds.
    // The pending_registrations table has RLS = FALSE (service_role only), so
    // it is never accessible to clients.
    const { error: pendingError } = await supabase
      .from("pending_registrations")
      .upsert(
        {
          email,
          first_name: first_name || "",
          last_name: last_name || "",
          phone: phone || null,
          role: role || "both",
          otp,
          otp_expires_at: expiresAt,
          // Store the raw password so verify-otp can call createUser with it.
          // This row is deleted immediately after successful OTP verification.
          password_hash: password || "",
        },
        { onConflict: "email" }
      );

    if (pendingError) {
      console.error("Failed to store pending registration:", pendingError);
      // Clean up the OTP we just inserted
      await supabase.from("email_otps").delete().eq("email", email);
      return new Response(
        JSON.stringify({ error: "Failed to save registration data. Please try again." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Send OTP email via Resend ─────────────────────────────────────────────
    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #16a34a; margin: 0;">ExWadda</h1>
          <p style="color: #52525b; margin: 4px 0 0;">Secure Escrow Platform</p>
        </div>
        <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 12px; padding: 24px; margin-bottom: 24px;">
          <h2 style="color: #15803d; margin-top: 0;">Verify Your Email Address</h2>
          <p>Hi <strong>${first_name}</strong>,</p>
          <p>Welcome to ExWadda! Use the verification code below to activate your account:</p>
          <div style="text-align: center; margin: 24px 0;">
            <div style="display: inline-block; background: #16a34a; color: white; font-size: 36px; font-weight: bold; letter-spacing: 10px; padding: 16px 32px; border-radius: 8px;">
              ${otp}
            </div>
          </div>
          <p style="color: #6b7280; font-size: 14px; text-align: center;">
            This code expires in <strong>10 minutes</strong>.
          </p>
        </div>
        <p style="color: #9ca3af; font-size: 12px; text-align: center;">
          If you did not request this, please ignore this email. Your account will not be created.
        </p>
      </div>
    `;

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: "ExWadda <support@exwadda.co.ke>",
        to: [email],
        subject: `${otp} — Your ExWadda verification code`,
        html: emailHtml,
      }),
    });

    if (!resendRes.ok) {
      const resendError = await resendRes.json().catch(() => ({}));
      console.error("Resend API error:", JSON.stringify(resendError));

      // Clean up on email failure
      await supabase.from("email_otps").delete().eq("email", email);
      await supabase.from("pending_registrations").delete().eq("email", email);

      // Resend returns 403 when sending to unverified addresses in test mode
      // (onboarding@resend.dev can only send to the Resend account owner's email)
      const isTestingRestriction =
        resendError?.statusCode === 403 ||
        resendError?.name === "validation_error" ||
        JSON.stringify(resendError).includes("can only send");

      return new Response(
        JSON.stringify({
          error: isTestingRestriction
            ? "During testing, emails can only be sent to the Resend account owner's email address (jramtechnologies@gmail.com). Use that email to test registration, or verify your domain at resend.com/domains."
            : "Failed to send verification email. Please try again.",
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`OTP sent successfully to ${email}`);

    return new Response(
      JSON.stringify({ success: true, message: "Verification code sent to your email." }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("send-otp unhandled error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error. Please try again." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
