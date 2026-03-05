import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts";
import { audit } from "../_shared/audit.ts";

/**
 * daraja-stk-push — initiates Safaricom STK push for wallet deposit.
 *
 * HOW THE CALLBACK SIGNING WORKS:
 * ─────────────────────────────────
 * Problem: We need to embed ?sig=HMAC(secret, checkoutRequestId) in the callback
 * URL so daraja-callback can verify it. But Safaricom gives us the CheckoutRequestID
 * only AFTER we've already sent the callback URL.
 *
 * Solution: Use a pre-generated nonce as the "checkoutRequestId" for signing.
 * 1. Generate a random nonce (32 hex chars)
 * 2. Compute sig = HMAC-SHA256(secret, nonce)
 * 3. Embed ?cid={nonce}&sig={sig} in callback URL — sent to Safaricom
 * 4. Store nonce in pending wallet_transaction row
 * 5. daraja-callback verifies HMAC(secret, cid) == sig ✓
 * 6. daraja-callback then matches the pending row by phone+amount fallback
 *    OR by the real CheckoutRequestID in the callback body
 *
 * This gives us HMAC verification without needing the CheckoutRequestID upfront.
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const KENYA_PHONE_REGEX = /^2547\d{8}$|^2541\d{8}$/;
const MIN_AMOUNT = 1;
const MAX_AMOUNT = 150_000;

function getDarajaBase(): string {
  return Deno.env.get("DARAJA_ENV") === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";
}

async function getDarajaToken(): Promise<string> {
  const key    = Deno.env.get("DARAJA_CONSUMER_KEY")!;
  const secret = Deno.env.get("DARAJA_CONSUMER_SECRET")!;
  if (!key || !secret) throw new Error("DARAJA_CONSUMER_KEY/SECRET not set");

  const darajaBase = getDarajaBase();
  console.log("Daraja ENV:", Deno.env.get("DARAJA_ENV"), "Base:", darajaBase);
  const res = await fetch(
    `${darajaBase}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${btoa(`${key}:${secret}`)}` } }
  );
  const rawText = await res.text();
  console.log("Daraja token status:", res.status, "body:", rawText.substring(0, 300));
  if (!res.ok) throw new Error(`Daraja auth failed (${res.status}): ${rawText.substring(0, 200)}`);
  let data: any;
  try { data = JSON.parse(rawText); } catch { throw new Error(`Daraja non-JSON: ${rawText.substring(0, 200)}`); }
  if (!data.access_token) throw new Error("Daraja token missing: " + JSON.stringify(data));
  return data.access_token;
}

/** HMAC-SHA256(secret, message) → hex string */
async function hmacHex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign"]
  );
  const buf = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const clientIp =
    req.headers.get("x-real-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";

  const errRes = (msg: string, status = 400) =>
    new Response(JSON.stringify({ error: msg }), {
      status, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    // ── 1. Auth ──────────────────────────────────────────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return errRes("Unauthorized", 401);

    const anonClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await anonClient.auth.getUser();
    if (userError || !user) return errRes("Unauthorized", 401);

    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // ── 2. Rate limit: 5 STK pushes per 5 min per user ──────────────────────
    const rl = await checkRateLimit(serviceClient, {
      key:           `stk_push:user:${user.id}`,
      windowSeconds: 300,
      maxRequests:   5,
    });

    if (!rl.allowed) {
      await audit(serviceClient, {
        action: "rate_limit_hit",
        user_id: user.id,
        metadata: { endpoint: "daraja-stk-push", ip: clientIp },
        success: false,
        error_message: "Rate limit exceeded",
        ip: clientIp,
      });
      return rateLimitResponse(rl, corsHeaders);
    }

    // ── 3. Validate input ────────────────────────────────────────────────────
    let body: any;
    try { body = await req.json(); } catch { return errRes("Invalid request body"); }

    const { phone, amount } = body;
    if (!phone || !amount) return errRes("Phone number and amount are required");

    // Normalize phone
    let formattedPhone = String(phone).replace(/\s+/g, "").replace(/^\+/, "").replace(/^0/, "254");
    if (!formattedPhone.startsWith("254")) formattedPhone = "254" + formattedPhone;
    if (!KENYA_PHONE_REGEX.test(formattedPhone)) {
      return errRes("Invalid Kenyan phone number. Use format: 07XXXXXXXX or 01XXXXXXXX");
    }

    const numAmount = Math.round(Number(amount));
    if (isNaN(numAmount) || numAmount < MIN_AMOUNT) return errRes(`Minimum deposit is KES ${MIN_AMOUNT}`);
    if (numAmount > MAX_AMOUNT) return errRes(`Maximum deposit is KES ${MAX_AMOUNT.toLocaleString()}`);

    // ── 4. Block duplicate pending deposits (2 min cooldown) ────────────────
    const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const { data: recentPending } = await serviceClient
      .from("wallet_transactions")
      .select("id")
      .eq("user_id", user.id)
      .eq("type", "deposit_pending")
      .gte("created_at", twoMinAgo)
      .maybeSingle();

    if (recentPending) {
      return errRes("A deposit is already pending. Please wait 2 minutes before trying again.", 429);
    }

    // ── 5. Generate pre-signed nonce for callback HMAC ───────────────────────
    // We sign a nonce NOW so the callback URL has a valid HMAC before we know
    // the CheckoutRequestID. daraja-callback verifies HMAC(secret, nonce).
    const CALLBACK_SECRET = Deno.env.get("DARAJA_CALLBACK_SECRET");
    if (!CALLBACK_SECRET) throw new Error("DARAJA_CALLBACK_SECRET is not set");

    const nonceBytes = new Uint8Array(16);
    crypto.getRandomValues(nonceBytes);
    const nonce = Array.from(nonceBytes).map(b => b.toString(16).padStart(2, "0")).join("");
    const sig   = await hmacHex(CALLBACK_SECRET, nonce);

    const supabaseUrl  = Deno.env.get("SUPABASE_URL")!;
    const callbackUrl  = `${supabaseUrl}/functions/v1/daraja-callback?cid=${nonce}&sig=${sig}`;

    // ── 6. Build STK push payload ────────────────────────────────────────────
    const shortcode = Deno.env.get("DARAJA_SHORTCODE")!;
    const passkey   = Deno.env.get("DARAJA_PASSKEY")!;
    if (!shortcode || !passkey) throw new Error("DARAJA_SHORTCODE/PASSKEY not set");

    const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, "").slice(0, 14);
    const password  = btoa(`${shortcode}${passkey}${timestamp}`);
    const token     = await getDarajaToken();

    const stkPayload = {
      BusinessShortCode: shortcode,
      Password:          password,
      Timestamp:         timestamp,
      TransactionType:   "CustomerPayBillOnline",
      Amount:            numAmount,
      PartyA:            formattedPhone,
      PartyB:            shortcode,
      PhoneNumber:       formattedPhone,
      CallBackURL:       callbackUrl,   // ← has valid HMAC sig via nonce
      AccountReference:  "ExWadda",
      TransactionDesc:   `Wallet Deposit KES ${numAmount}`,
    };

    // ── 7. Send STK push to Safaricom ────────────────────────────────────────
    const stkRes = await fetch(`${getDarajaBase()}/mpesa/stkpush/v1/processrequest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(stkPayload),
    });

    const stkRaw = await stkRes.text();
    console.log("STK push status:", stkRes.status, "body:", stkRaw.substring(0, 500));

    let stkData: any;
    try { stkData = JSON.parse(stkRaw); } catch {
      return errRes("M-Pesa service unavailable. Please try again shortly. (" + stkRaw.substring(0, 100) + ")");
    }

    if (stkData.ResponseCode !== "0") {
      console.error("STK push failed:", stkData);
      return errRes(
        stkData.errorMessage ??
        stkData.ResponseDescription ??
        "M-Pesa STK push failed. Please try again."
      );
    }

    const checkoutRequestId: string = stkData.CheckoutRequestID;

    // ── 8. Record pending deposit — store BOTH nonce (for callback matching)
    //       and CheckoutRequestID (for Safaricom idempotency) ─────────────────
    const { error: insertErr } = await serviceClient.from("wallet_transactions").insert({
      user_id:             user.id,
      type:                "deposit_pending",
      amount:              numAmount,
      fee:                 0,
      net_amount:          numAmount,
      phone:               formattedPhone,
      checkout_request_id: checkoutRequestId,
      // nonce stored so daraja-callback can match this row
      idempotency_key:     nonce,
    });

    if (insertErr) {
      console.error("Failed to store pending deposit:", insertErr);
      // Don't fail the user — the STK push was already sent. Callback will still come.
      console.warn("User may need to contact support if deposit doesn't reflect.");
    }

    await audit(serviceClient, {
      action:  "wallet_deposit",
      user_id: user.id,
      amount:  numAmount,
      metadata: { checkoutRequestId, nonce, phone: formattedPhone, ip: clientIp },
      success: true,
      ip:      clientIp,
    });

    return new Response(
      JSON.stringify({
        success:           true,
        message:           "M-Pesa payment request sent. Enter your PIN when prompted on your phone.",
        checkoutRequestId: checkoutRequestId,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (e: any) {
    console.error("daraja-stk-push error:", e);
    return new Response(JSON.stringify({ error: e.message || "Internal server error. Please try again." }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});