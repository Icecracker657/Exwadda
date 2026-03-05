import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts";
import { audit } from "../_shared/audit.ts";

/**
 * release-funds — buyer confirms receipt and releases escrow to seller.
 *
 * Security:
 *  - Caller must be authenticated buyer
 *  - release_escrow_funds() RPC does ALL state changes in ONE SQL transaction:
 *      SELECT FOR UPDATE on transaction + escrow + wallet rows
 *      Verify buyer_id, status, product_received
 *      Credit seller (and broker) atomically
 *      Update escrow_hold + transaction status
 *      Write audit log + idempotency key
 *  - Rate limited: 3 releases per 10 min per user
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function sendEmail(
  resendKey: string,
  to: string,
  subject: string,
  html: string
): Promise<void> {
  if (!to?.includes("@")) return;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${resendKey}` },
      body: JSON.stringify({ from: "ExWadda <support@exwadda.co.ke>", to: [to], subject, html }),
    });
    if (!res.ok) console.error("Email send failed:", await res.json());
  } catch (e) {
    console.error("sendEmail error:", e);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const clientIp =
    req.headers.get("x-real-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";

  try {
    // ── 1. Auth ──────────────────────────────────────────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const anonClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await anonClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // ── 2. Rate limit — 3 releases per 10 min per user ───────────────────────
    const rl = await checkRateLimit(serviceClient, {
      key:           `release:user:${user.id}`,
      windowSeconds: 600,
      maxRequests:   3,
    });

    if (!rl.allowed) {
      await audit(serviceClient, {
        action:       "rate_limit_hit",
        user_id:      user.id,
        metadata:     { endpoint: "release-funds", ip: clientIp },
        success:      false,
        error_message: "Rate limit exceeded",
        ip:           clientIp,
      });
      return rateLimitResponse(rl, corsHeaders);
    }

    // ── 3. Parse body ────────────────────────────────────────────────────────
    let body: any;
    try { body = await req.json(); } catch {
      return new Response(JSON.stringify({ error: "Invalid request body" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { transaction_id } = body;
    if (!transaction_id) {
      return new Response(JSON.stringify({ error: "transaction_id is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── 4. ATOMIC RPC: everything in one SQL transaction ─────────────────────
    // release_escrow_funds() with row locks:
    //   a) Idempotency check
    //   b) SELECT FOR UPDATE on transactions
    //   c) Verify auth.uid() === buyer_id (done in TS since RPC is service_role)
    //   d) Verify status = 'accepted' AND product_received = TRUE
    //   e) SELECT FOR UPDATE on escrow_holds
    //   f) Compute seller payout and broker commission
    //   g) Credit seller wallet (INSERT ON CONFLICT DO UPDATE)
    //   h) Credit broker wallet if applicable
    //   i) UPDATE escrow_hold → released
    //   j) UPDATE transaction → released
    //   k) Audit log
    //   l) Idempotency key
    //
    // Buyer verification is passed as _buyer_id so the RPC enforces it inside the txn.
    const idempotencyKey = `release:${transaction_id}:${user.id}`;

    const { data: rpcResult, error: rpcError } = await serviceClient.rpc(
      "release_escrow_funds",
      {
        _transaction_id:  transaction_id,
        _buyer_id:        user.id,
        _idempotency_key: idempotencyKey,
      }
    );

    if (rpcError) {
      console.error("release_escrow_funds RPC error:", rpcError);
      await audit(serviceClient, {
        action:         "transaction_released",
        user_id:        user.id,
        transaction_id: transaction_id,
        metadata:       { rpcError: rpcError.message, ip: clientIp },
        success:        false,
        error_message:  rpcError.message,
        ip:             clientIp,
      });
      return new Response(JSON.stringify({ error: "Failed to release funds. Please try again." }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const result = rpcResult as {
      status: string;
      reason?: string;
      seller_payout?: number;
      broker_amount?: number;
    };

    if (result.status === "already_processed") {
      return new Response(JSON.stringify({ success: true, message: "Funds already released." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (result.status === "error") {
      const errors: Record<string, { msg: string; code: number }> = {
        transaction_not_found:     { msg: "Transaction not found.",                              code: 404 },
        unauthorized:              { msg: "Only the buyer can release funds.",                   code: 403 },
        wrong_status:              { msg: "Transaction is not in the correct state to release.", code: 400 },
        product_not_received:      { msg: "Buyer has not confirmed receipt yet.",                code: 400 },
        escrow_not_found:          { msg: "Escrow hold not found or already released.",          code: 400 },
        invalid_payout_calculation:{ msg: "Payout calculation error. Contact support.",          code: 500 },
      };
      const mapped = errors[result.reason ?? ""] ?? { msg: `Release failed: ${result.reason}`, code: 400 };
      return new Response(JSON.stringify({ error: mapped.msg }), {
        status: mapped.code, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── 5. Success — send email notifications ────────────────────────────────
    if (result.status === "released") {
      const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
      const SITE_URL = Deno.env.get("SITE_URL") ?? "https://exwadda.co.ke";
      const dashboardUrl = `${SITE_URL}/dashboard`;
      const sellerPayout = result.seller_payout ?? 0;

      if (RESEND_API_KEY) {
        // Fetch profiles for email
        const { data: tx } = await serviceClient
          .from("transactions")
          .select("title, seller_id, buyer_id, seller_email, buyer_email")
          .eq("id", transaction_id)
          .single();

        if (tx?.seller_id) {
          const { data: sellerProfile } = await serviceClient
            .from("profiles").select("email, first_name").eq("user_id", tx.seller_id).single();

          const sellerEmail = sellerProfile?.email ?? tx.seller_email;
          if (sellerEmail) {
            await sendEmail(
              RESEND_API_KEY, sellerEmail,
              `🎉 Funds Released: ${tx.title}`,
              `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
                <h1 style="color:#16a34a;">ExWadda</h1>
                <h2>🎉 Funds Released!</h2>
                <p>Hi ${sellerProfile?.first_name ?? ""},</p>
                <p>The buyer confirmed receipt and released escrow for <strong>${tx.title}</strong>.</p>
                <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin:16px 0;">
                  <p style="margin:0;"><strong>KES ${sellerPayout.toLocaleString()} credited to your wallet.</strong></p>
                </div>
                <p>You can now withdraw from your ExWadda wallet.</p>
                <a href="${dashboardUrl}" style="color:#16a34a;">Go to Dashboard →</a>
              </div>`
            );
          }
        }

        if (tx?.buyer_id) {
          const { data: buyerProfile } = await serviceClient
            .from("profiles").select("email, first_name").eq("user_id", tx.buyer_id).single();

          const buyerEmail = buyerProfile?.email ?? tx.buyer_email;
          if (buyerEmail) {
            await sendEmail(
              RESEND_API_KEY, buyerEmail,
              `Transaction Complete: ${tx?.title}`,
              `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
                <h1 style="color:#16a34a;">ExWadda</h1>
                <h2>✅ Transaction Complete</h2>
                <p>Hi ${buyerProfile?.first_name ?? ""},</p>
                <p>You released the escrow funds for <strong>${tx?.title}</strong>. The seller has been paid.</p>
                <a href="${dashboardUrl}" style="color:#16a34a;">View on Dashboard →</a>
              </div>`
            );
          }
        }
      }

      return new Response(
        JSON.stringify({
          success: true,
          sellerPayout,
          message: `Funds released. KES ${sellerPayout.toLocaleString()} credited to seller.`,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.error("Unexpected release_escrow_funds result:", result);
    return new Response(JSON.stringify({ error: "Unexpected error. Please contact support." }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error("release-funds unhandled error:", err);
    return new Response(JSON.stringify({ error: "Internal server error." }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
