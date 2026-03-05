import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts";
import { audit } from "../_shared/audit.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function sendEmail(resendKey: string, to: string, subject: string, html: string): Promise<void> {
  if (!to?.includes("@")) return;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${resendKey}` },
      body: JSON.stringify({ from: "ExWadda <support@exwadda.co.ke>", to: [to], subject, html }),
    });
    if (!res.ok) console.error("Email failed:", await res.json());
  } catch (e) { console.error("sendEmail error:", e); }
}

async function getDarajaToken(base: string, key: string, secret: string): Promise<string> {
  const res = await fetch(`${base}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${btoa(`${key}:${secret}`)}` },
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("Daraja token missing");
  return data.access_token;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const buf = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function triggerStkPush(supabase: any, buyerId: string, buyerTotal: number, transactionId: string, txTitle: string): Promise<{ success: boolean; error?: string }> {
  try {
    // Get buyer profile for phone
    const { data: profile } = await supabase.from("profiles").select("phone, email").eq("user_id", buyerId).single();
    if (!profile?.phone) return { success: false, error: "Buyer phone not found. Please update your profile." };

    let phone = String(profile.phone).replace(/\s+/g, "").replace(/^\+/, "").replace(/^0/, "254");
    if (!phone.startsWith("254")) phone = "254" + phone;

    const DARAJA_ENV = Deno.env.get("DARAJA_ENV");
    const base = DARAJA_ENV === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke";
    const key = Deno.env.get("DARAJA_CONSUMER_KEY")!;
    const secret = Deno.env.get("DARAJA_CONSUMER_SECRET")!;
    const shortcode = Deno.env.get("DARAJA_SHORTCODE")!;
    const passkey = Deno.env.get("DARAJA_PASSKEY")!;
    const CALLBACK_SECRET = Deno.env.get("DARAJA_CALLBACK_SECRET")!;
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

    const token = await getDarajaToken(base, key, secret);
    const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, "").slice(0, 14);
    const password = btoa(`${shortcode}${passkey}${timestamp}`);

    const nonceBytes = new Uint8Array(16);
    crypto.getRandomValues(nonceBytes);
    const nonce = Array.from(nonceBytes).map(b => b.toString(16).padStart(2, "0")).join("");
    const sig = await hmacHex(CALLBACK_SECRET, nonce);
    const callbackUrl = `${SUPABASE_URL}/functions/v1/daraja-callback?cid=${nonce}&sig=${sig}&transaction_id=${transactionId}`;

    const amount = Math.ceil(buyerTotal);
    const stkRes = await fetch(`${base}/mpesa/stkpush/v1/processrequest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: amount,
        PartyA: phone,
        PartyB: shortcode,
        PhoneNumber: phone,
        CallBackURL: callbackUrl,
        AccountReference: "ExWadda",
        TransactionDesc: `Fund Escrow: ${txTitle}`,
      }),
    });

    const stkData = await stkRes.json();
    if (stkData.ResponseCode !== "0") {
      console.error("STK push failed:", stkData);
      return { success: false, error: stkData.errorMessage ?? stkData.ResponseDescription ?? "M-Pesa request failed" };
    }

    // Record pending deposit
    await supabase.from("wallet_transactions").insert({
      user_id: buyerId,
      type: "deposit_pending",
      amount: amount,
      fee: 0,
      net_amount: amount,
      phone,
      checkout_request_id: stkData.CheckoutRequestID,
      idempotency_key: nonce,
    });

    return { success: true };
  } catch (e: any) {
    console.error("triggerStkPush error:", e);
    return { success: false, error: e.message };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const clientIp = req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    const url = new URL(req.url);
    const token = url.searchParams.get("token");
    const transactionId = url.searchParams.get("transaction_id");

    if (!token || !transactionId) return htmlPage("Invalid Link", "This approval link is missing parameters.", false);

    const rl = await checkRateLimit(supabase, { key: `approve:ip:${clientIp}`, windowSeconds: 900, maxRequests: 5 });
    if (!rl.allowed) return htmlPage("Too Many Attempts", "Too many approval attempts. Please try again in 15 minutes.", false);

    const idempotencyKey = `approve:${transactionId}:${token}`;

    const { data: rpcResult, error: rpcError } = await supabase.rpc("approve_and_fund_transaction", {
      _transaction_id: transactionId,
      _approval_token: token,
      _idempotency_key: idempotencyKey,
    });

    if (rpcError) {
      console.error("RPC error:", rpcError);
      return htmlPage("Error", "An unexpected error occurred. Please contact ExWadda support.", false);
    }

    const result = rpcResult as any;
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    const SITE_URL = Deno.env.get("SITE_URL") ?? "https://exwadda.co.ke";
    const dashboardUrl = `${SITE_URL}/dashboard`;
    const txUrl = `${SITE_URL}/dashboard/transaction/${transactionId}`;

    if (result.status === "already_processed") {
      const SITE_URL3 = Deno.env.get("SITE_URL") ?? "https://exwadda.co.ke";
return Response.redirect(`${SITE_URL3}/dashboard/transaction/${transactionId}`, 302);
    }

    if (result.status === "error") {
      const messages: Record<string, string> = {
        invalid_token: "This approval link is invalid.",
        token_expired: "This approval link has expired. Ask the creator to resend it.",
        wrong_status: "This transaction has already been processed.",
        transaction_not_found: "Transaction not found. Please contact support.",
      };
      return htmlPage("Cannot Approve", messages[result.reason ?? ""] ?? `Error: ${result.reason}`, false);
    }

    if (result.status === "insufficient_funds") {
      const buyerTotal = result.buyer_total ?? 0;
      const buyerId = result.buyer_id;
      const txTitle = result.tx_title ?? "Transaction";

      // Try STK push immediately
      let stkMessage = "";
      if (buyerId) {
        const stkResult = await triggerStkPush(supabase, buyerId, buyerTotal, transactionId, txTitle);
        if (stkResult.success) {
          stkMessage = `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin:16px 0;">
            <p style="color:#15803d;font-weight:bold;margin:0 0 8px;">📱 M-Pesa Payment Requested!</p>
            <p style="margin:0;color:#166534;">Check your phone — enter your M-Pesa PIN to fund KES ${buyerTotal.toLocaleString()} into escrow.</p>
          </div>`;
        } else {
          stkMessage = `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px;margin:16px 0;">
            <p style="color:#dc2626;margin:0 0 8px;">Could not send M-Pesa request automatically.</p>
            <p style="margin:0;color:#7f1d1d;">Please use the "Fund Your Transaction" button on your dashboard.</p>
          </div>`;
        }
      }

      // Notify buyer by email
      if (RESEND_API_KEY && buyerId) {
        const { data: buyerProfile } = await supabase.from("profiles").select("email, first_name").eq("user_id", buyerId).single();
        if (buyerProfile?.email) {
          await sendEmail(RESEND_API_KEY, buyerProfile.email,
            `Action Required: Fund Transaction — ${txTitle}`,
            `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
              <h1 style="color:#16a34a;">ExWadda</h1>
              <h2>💳 Transaction Approved — Funding Required</h2>
              <p>Hi ${buyerProfile.first_name ?? ""},</p>
              <p>You approved <strong>${txTitle}</strong> but your wallet needs KES ${buyerTotal.toLocaleString()} to fund the transaction.</p>
              <a href="${txUrl}" style="display:inline-block;background:#16a34a;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">Fund Your Transaction →</a>
            </div>`
          );
        }
      }

      return new Response(
        `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Approved — Funding Required — ExWadda</title>
        <style>*{box-sizing:border-box}body{font-family:-apple-system,Arial,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f4f4f5;padding:16px}.card{background:white;padding:40px;border-radius:16px;max-width:480px;width:100%;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,.12)}.icon{font-size:48px;margin-bottom:16px}h1{color:#f59e0b;margin:0 0 16px;font-size:24px}p{color:#52525b;line-height:1.6;margin:0 0 16px}a{display:inline-block;background:#16a34a;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold}</style>
        </head><body><div class="card">
          <div class="icon">⚠️</div>
          <h1>Approved — Funding Required</h1>
          <p>You approved <strong>${result.tx_title ?? "the transaction"}</strong>. Now fund KES ${buyerTotal.toLocaleString()} into escrow to complete it.</p>
          ${stkMessage}
          <a href="${txUrl}">Fund Your Transaction →</a>
        </div></body></html>`,
        { headers: { "Content-Type": "text/html" } }
      );
    }

    if (result.status === "funded") {
      if (RESEND_API_KEY) {
        const buyerTotal = result.buyer_total ?? 0;
        if (result.seller_email) {
          await sendEmail(RESEND_API_KEY, result.seller_email, `Transaction Funded — Release Your Product: ${result.tx_title}`,
            `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
              <h1 style="color:#16a34a;">ExWadda</h1><h2>💰 account has been Funded</h2>
              <p>KES ${buyerTotal.toLocaleString()} is locked in exwadda for <strong>${result.tx_title}</strong>.</p>
              <p>Release your product/service to the buyer. Once they confirm received, funds are released to your wallet.</p>
              <a href="${dashboardUrl}" style="display:inline-block;background:#16a34a;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">Go to Dashboard</a>
            </div>`
          );
        }
        if (result.buyer_email) {
          await sendEmail(RESEND_API_KEY, result.buyer_email, `Transaction Approved & Funded: ${result.tx_title}`,
            `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
              <h1 style="color:#16a34a;">ExWadda</h1><h2>✅ Transaction Funded</h2>
              <p>KES ${buyerTotal.toLocaleString()} is held in escrow for <strong>${result.tx_title}</strong>.</p>
              <a href="${dashboardUrl}" style="color:#16a34a;">Track on Dashboard →</a>
            </div>`
          );
        }
      }
     const SITE_URL2 = Deno.env.get("SITE_URL") ?? "https://exwadda.co.ke";
return Response.redirect(`${SITE_URL2}/dashboard/transaction/${transactionId}`, 302);
    }

    return htmlPage("Error", "An unexpected error occurred. Please contact support.", false);

  } catch (err: any) {
    console.error("[approve-transaction] error:", err);
    return htmlPage("Error", "An unexpected error occurred. Please contact ExWadda support.", false);
  }
});

function htmlPage(title: string, message: string, success = true): Response {
  const color = success ? "#16a34a" : "#dc2626";
  const icon = success ? "✅" : "❌";
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${title} — ExWadda</title>
    <style>*{box-sizing:border-box}body{font-family:-apple-system,Arial,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f4f4f5;padding:16px}.card{background:white;padding:40px;border-radius:16px;max-width:480px;width:100%;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,.12)}.icon{font-size:48px;margin-bottom:16px}h1{color:${color};margin:0 0 16px;font-size:24px}p{color:#52525b;line-height:1.6;margin:0 0 24px}a{display:inline-block;background:#16a34a;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold}</style>
    </head><body><div class="card"><div class="icon">${icon}</div><h1>${title}</h1><p>${message}</p>
    <a href="https://exwadda.co.ke/dashboard" style="display:inline-block;background:#16a34a;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;">Go to Dashboard</a></div></body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}