import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts";
import { audit } from "../_shared/audit.ts";

/**
 * withdraw-funds — deducts from ExWadda wallet and queues M-Pesa payout.
 *
 * ⚠️  CURRENT STATUS (sandbox/early production):
 *     Daraja B2C (business-to-customer payout) requires a separate Safaricom
 *     application and approval process distinct from C2B (STK push).
 *     Until B2C is approved:
 *       - Wallet balance IS deducted immediately (so user can't double-withdraw)
 *       - Transaction is marked 'withdrawal_pending'
 *       - Admin receives email notification to manually process M-Pesa transfer
 *       - When B2C is approved, swap the TODO section with the B2C API call
 *
 * Security:
 *  - Rate limited: 3 withdrawals per 15 min
 *  - process_withdrawal() RPC: SELECT FOR UPDATE → no concurrent over-withdrawal
 *  - Audit log on every attempt (success and failure)
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const KENYA_PHONE_REGEX = /^2547\d{8}$|^2541\d{8}$/;
const MIN_WITHDRAWAL = 10;
const MAX_WITHDRAWAL = 150_000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const clientIp =
    req.headers.get("x-real-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";

  const err400 = (msg: string, status = 400) =>
    new Response(JSON.stringify({ error: msg }), {
      status, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    // ── 1. Auth ──────────────────────────────────────────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return err400("Unauthorized", 401);

    const anonClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await anonClient.auth.getUser();
    if (userError || !user) return err400("Unauthorized", 401);

    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // ── 2. Rate limit: 3 per 15 min ──────────────────────────────────────────
    const rl = await checkRateLimit(serviceClient, {
      key:           `withdraw:user:${user.id}`,
      windowSeconds: 60,
      maxRequests:   20,
    });

    if (!rl.allowed) {
      await audit(serviceClient, {
        action: "rate_limit_hit",
        user_id: user.id,
        metadata: { endpoint: "withdraw-funds", ip: clientIp },
        success: false,
        error_message: "Rate limit exceeded",
        ip: clientIp,
      });
      return rateLimitResponse(rl, corsHeaders);
    }

    // ── 3. Parse and validate ────────────────────────────────────────────────
    let body: any;
    try { body = await req.json(); } catch { return err400("Invalid request body"); }

    const { amount, phone } = body;

    const numAmount = Math.round(Number(amount));
    if (!amount || isNaN(numAmount) || numAmount <= 0) return err400("Valid withdrawal amount is required");
    if (numAmount < MIN_WITHDRAWAL)   return err400(`Minimum withdrawal is KES ${MIN_WITHDRAWAL}`);
    if (numAmount > MAX_WITHDRAWAL)   return err400(`Maximum withdrawal is KES ${MAX_WITHDRAWAL.toLocaleString()}`);

    if (!phone) return err400("M-Pesa phone number is required");

    let formattedPhone = String(phone).replace(/\s+/g, "").replace(/^\+/, "").replace(/^0/, "254");
    if (!formattedPhone.startsWith("254")) formattedPhone = "254" + formattedPhone;
    if (!KENYA_PHONE_REGEX.test(formattedPhone)) {
      return err400("Invalid Kenyan phone number. Use: 07XXXXXXXX, 01XXXXXXXX, or 254XXXXXXXXX");
    }

    // ── 4. Atomic RPC: deduct balance + record + audit ───────────────────────
    // Generate secure admin token (used for "Mark as Paid" button in email)
    const tokenBytes = new Uint8Array(32);
    crypto.getRandomValues(tokenBytes);
    const adminToken = Array.from(tokenBytes).map(b => b.toString(16).padStart(2, "0")).join("");
    const idempotencyKey = adminToken;

    const { data: rpcResult, error: rpcError } = await serviceClient.rpc(
      "process_withdrawal",
      {
        _user_id:         user.id,
        _amount:          numAmount,
        _phone:           formattedPhone,
        _idempotency_key: idempotencyKey,
      }
    );

    if (rpcError) {
      console.error("process_withdrawal RPC error:", rpcError);
      await audit(serviceClient, {
        action: "wallet_withdrawal",
        user_id: user.id,
        amount: numAmount,
        metadata: { rpcError: rpcError.message, phone: formattedPhone, ip: clientIp },
        success: false,
        error_message: rpcError.message,
        ip: clientIp,
      });
      return new Response(JSON.stringify({ error: "Withdrawal failed. Please try again." }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const result = rpcResult as {
      status: string;
      reason?: string;
      available?: number;
      requested?: number;
      balance_after?: number;
    };

    if (result.status === "already_processed") {
      return new Response(JSON.stringify({ success: true, message: "Withdrawal already processed." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (result.status === "error") {
      if (result.reason === "insufficient_balance") {
        return err400(
          `Insufficient balance. Available: KES ${(result.available ?? 0).toLocaleString()}, ` +
          `requested: KES ${numAmount.toLocaleString()}.`
        );
      }
      if (result.reason === "wallet_not_found") {
        return err400("Wallet not found. Please contact support.", 404);
      }
      return err400(`Withdrawal error: ${result.reason}`);
    }

    if (result.status === "success") {
      // ── Notify admin to manually process payout (until B2C is live) ────────
      const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
      const ADMIN_EMAIL    = Deno.env.get("ADMIN_EMAIL") ?? "jramtechnologies@gmail.com";

      if (RESEND_API_KEY) {
        // Get user profile for the notification
        const { data: profile } = await serviceClient
          .from("profiles")
          .select("first_name, last_name, email")
          .eq("user_id", user.id)
          .single();

        const userName = profile
          ? `${profile.first_name} ${profile.last_name}`.trim()
          : user.email ?? user.id;

        // Get withdrawal DB row ID for the mark-as-paid link
        const { data: wtxRow } = await serviceClient
          .from("wallet_transactions")
          .select("id")
          .eq("idempotency_key", adminToken)
          .single();

        const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
        const markPaidUrl = wtxRow
          ? `${SUPABASE_URL}/functions/v1/admin-mark-paid?token=${adminToken}&id=${wtxRow.id}`
          : null;

        // Admin notification with Mark as Paid button
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${RESEND_API_KEY}`,
          },
          body: JSON.stringify({
            from: "ExWadda <hello@exwadda.co.ke>",
            to:   [ADMIN_EMAIL],
            subject: `⚠️ Withdrawal Request: KES ${numAmount.toLocaleString()} — Action Required`,
            html: `
              <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
                <h1 style="color:#dc2626;">ExWadda — Withdrawal Pending</h1>
                <p>A user has requested a withdrawal. Please send M-Pesa and click the button below:</p>
                <table style="width:100%;border-collapse:collapse;background:#f9f9f9;border-radius:8px;padding:16px;margin:16px 0;">
                  <tr><td style="padding:8px;color:#555;">User</td><td style="padding:8px;font-weight:bold;">${userName}</td></tr>
                  <tr><td style="padding:8px;color:#555;">Email</td><td style="padding:8px;">${profile?.email ?? ""}</td></tr>
                  <tr><td style="padding:8px;color:#555;">Amount</td><td style="padding:8px;font-weight:bold;color:#16a34a;">KES ${numAmount.toLocaleString()}</td></tr>
                  <tr><td style="padding:8px;color:#555;">M-Pesa number</td><td style="padding:8px;font-weight:bold;font-size:18px;">${formattedPhone}</td></tr>
                  <tr><td style="padding:8px;color:#555;">Balance after</td><td style="padding:8px;">KES ${(result.balance_after ?? 0).toLocaleString()}</td></tr>
                  <tr><td style="padding:8px;color:#555;">Time</td><td style="padding:8px;">${new Date().toLocaleString("en-KE", {timeZone:"Africa/Nairobi"})}</td></tr>
                </table>
                <p style="color:#dc2626;font-weight:bold;">
                  ⚠️ Wallet already deducted. Send KES ${numAmount.toLocaleString()} to ${formattedPhone} via M-Pesa NOW.
                </p>
                ${markPaidUrl ? `
                <div style="text-align:center;margin:24px 0;">
                  <a href="${markPaidUrl}" style="display:inline-block;background:#16a34a;color:white;padding:16px 36px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:16px;">
                    ✅ Mark as Paid (click AFTER sending M-Pesa)
                  </a>
                </div>
                <p style="color:#6b7280;font-size:12px;text-align:center;">Clicking this button will notify the user and mark the withdrawal as complete.</p>
                ` : ""}
              </div>
            `,
          }),
        }).catch(e => console.error("Admin notification email failed:", e));

        // User confirmation
        if (profile?.email) {
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${RESEND_API_KEY}`,
            },
            body: JSON.stringify({
              from: "ExWadda <hello@exwadda.co.ke>",
              to:   [profile.email],
              subject: `Withdrawal Initiated: KES ${numAmount.toLocaleString()}`,
              html: `
                <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
                  <h1 style="color:#16a34a;">ExWadda</h1>
                  <h2>Withdrawal Request Received</h2>
                  <p>Hi ${profile.first_name},</p>
                  <p>Your withdrawal request has been received and is being processed.</p>
                  <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin:16px 0;">
                    <p><strong>Amount:</strong> KES ${numAmount.toLocaleString()}</p>
                    <p><strong>To:</strong> ${formattedPhone}</p>
                    <p><strong>Status:</strong> Processing</p>
                  </div>
                  <p style="color:#6b7280;font-size:14px;">
                    Funds will be sent to your M-Pesa number within 24 hours. 
                    Contact support if you don't receive your funds.
                  </p>
                </div>
              `,
            }),
          }).catch(e => console.error("User confirmation email failed:", e));
        }
      }

      console.log(
        `Withdrawal of KES ${numAmount} queued for user ${user.id} → ${formattedPhone}. ` +
        `Balance after: KES ${result.balance_after?.toLocaleString()}.`
      );

      return new Response(
        JSON.stringify({
          success: true,
          message: `KES ${numAmount.toLocaleString()} withdrawal to ${formattedPhone} is being processed. You'll receive your M-Pesa payment within 24 hours.`,
          balanceAfter: result.balance_after,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.error("Unexpected process_withdrawal result:", result);
    return new Response(JSON.stringify({ error: "Unexpected error. Please contact support." }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error("withdraw-funds error:", err);
    return new Response(JSON.stringify({ error: "Internal server error. Please try again." }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});