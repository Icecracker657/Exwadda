import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const FROM = "ExWadda <support@exwadda.co.ke>";

async function sendEmail(resendKey: string, to: string, subject: string, html: string): Promise<void> {
  if (!to?.includes("@")) return;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${resendKey}` },
      body: JSON.stringify({ from: FROM, to: [to], subject, html }),
    });
    if (!res.ok) console.error(`Email failed for ${to}:`, await res.text());
    else console.log(`Email sent to ${to}: ${subject}`);
  } catch (e) { console.error(`sendEmail error for ${to}:`, e); }
}

function emailWrap(title: string, body: string, ctaText?: string, ctaUrl?: string, ctaColor = "#16a34a"): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:white;border-radius:12px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.08);">
<tr><td style="background:linear-gradient(135deg,#16a34a,#15803d);padding:28px 32px;text-align:center;">
  <img src="https://exwadda.co.ke/exwadda-icon.png" width="50" height="50" alt="ExWadda" style="display:block;margin:0 auto 8px;"/><span style="font-size:28px;font-weight:bold;color:white;letter-spacing:-0.5px;">ExWadda</span>
  <p style="color:rgba(255,255,255,0.85);margin:6px 0 0;font-size:13px;">Kenya's Trusted transaction Platform</p>
</td></tr>
<tr><td style="padding:32px;">
  <h1 style="margin:0 0 20px;font-size:22px;font-weight:bold;color:#111827;">${title}</h1>
  <div style="color:#374151;font-size:15px;line-height:1.7;">${body}</div>
  ${ctaText && ctaUrl ? `<div style="text-align:center;margin:28px 0 8px;">
    <a href="${ctaUrl}" style="display:inline-block;background:${ctaColor};color:white;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:15px;">${ctaText}</a>
  </div>` : ""}
</td></tr>
<tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:20px 32px;text-align:center;">
  <p style="margin:0;color:#6b7280;font-size:12px;">© ${new Date().getFullYear()} ExWadda Ltd · Kenya<br>
  Questions? <a href="mailto:support@exwadda.co.ke" style="color:#16a34a;">support@exwadda.co.ke</a></p>
</td></tr>
</table></td></tr></table></body></html>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });

    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    if (!RESEND_API_KEY) return new Response(JSON.stringify({ success: true, warning: "Email not configured" }), { status: 200, headers: corsHeaders });

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    let body: any;
    try { body = await req.json(); } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: corsHeaders });
    }

    const { transaction_id, event } = body;
    if (!transaction_id) return new Response(JSON.stringify({ error: "transaction_id required" }), { status: 400, headers: corsHeaders });

    const { data: tx, error: txErr } = await supabase.from("transactions").select("*").eq("id", transaction_id).single();
    if (txErr || !tx) return new Response(JSON.stringify({ error: "Transaction not found" }), { status: 404, headers: corsHeaders });

    const { data: creator } = await supabase.from("profiles").select("first_name, last_name, email, phone").eq("user_id", tx.created_by).single();
    const { data: buyerProfile } = tx.buyer_id ? await supabase.from("profiles").select("first_name, last_name, email, phone").eq("user_id", tx.buyer_id).single() : { data: null };
    const { data: sellerProfile } = tx.seller_id ? await supabase.from("profiles").select("first_name, last_name, email, phone").eq("user_id", tx.seller_id).single() : { data: null };

    const creatorName = creator ? `${creator.first_name ?? ""} ${creator.last_name ?? ""}`.trim() || "Someone" : "Someone";

    const SITE_URL = Deno.env.get("SITE_URL") ?? "https://exwadda.co.ke";
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const dashboardUrl = `${SITE_URL}/dashboard`;
    const txDetailUrl = `${SITE_URL}/dashboard/transaction/${tx.id}`;
    const approvalUrl = tx.approval_token
      ? `${SUPABASE_URL}/functions/v1/approve-transaction?token=${tx.approval_token}&transaction_id=${tx.id}`
      : dashboardUrl;

    const numAmount = Number(tx.amount);
    const fee = Number(tx.fee);
    const total = Number(tx.total);

    // Collect all participant emails
    const emailSet = new Set<string>();
    if (creator?.email) emailSet.add(creator.email);
    if (tx.counterparty_email) emailSet.add(tx.counterparty_email);
    if (tx.seller_email) emailSet.add(tx.seller_email);
    if (tx.buyer_email) emailSet.add(tx.buyer_email);
    const participantEmails = [...emailSet].filter(e => e?.includes("@"));

    const emailEvent = event ?? "created";

    // ── CREATED ───────────────────────────────────────────────────────────────
    if (emailEvent === "created") {
      const counterpartyEmail = tx.role_in_transaction === "broker" ? tx.buyer_email : tx.counterparty_email;

      if (counterpartyEmail) {
        await sendEmail(RESEND_API_KEY, counterpartyEmail,
          `Action Required: Approve Transaction — ${tx.title}`,
          emailWrap(
            "Transaction Approval Required",
            `<p><strong>${creatorName}</strong> has created an escrow transaction and needs your approval:</p>
            <table style="width:100%;background:#f9fafb;border-radius:8px;padding:16px;border-collapse:collapse;margin:16px 0;">
              <tr><td style="padding:6px 8px;color:#6b7280;">Title</td><td style="padding:6px 8px;font-weight:bold;">${tx.title}</td></tr>
              <tr><td style="padding:6px 8px;color:#6b7280;">Amount</td><td style="padding:6px 8px;font-weight:bold;color:#16a34a;">KES ${numAmount.toLocaleString()}</td></tr>
              <tr><td style="padding:6px 8px;color:#6b7280;">Platform fee (3%)</td><td style="padding:6px 8px;">KES ${fee.toLocaleString()} — paid by ${tx.fee_payer ?? "buyer"}</td></tr>
              <tr><td style="padding:6px 8px;color:#6b7280;">Total</td><td style="padding:6px 8px;font-weight:bold;">KES ${total.toLocaleString()}</td></tr>
              ${tx.description ? `<tr><td style="padding:6px 8px;color:#6b7280;">Details</td><td style="padding:6px 8px;">${tx.description}</td></tr>` : ""}
            </table>
            <p>Approving will deduct KES ${total.toLocaleString()} from your ExWadda wallet into exwadda transaction.</p>
            <p style="color:#6b7280;font-size:12px;">This approval link expires in 7 days. If you did not expect this, ignore it.</p>`,
            "✅ Approve Transaction", approvalUrl
          )
        );
      }

      if (creator?.email) {
        await sendEmail(RESEND_API_KEY, creator.email,
          `Transaction Created: ${tx.title}`,
          emailWrap(
            "Transaction Created ✅",
            `<p>Your transaction <strong>${tx.title}</strong> has been created.</p>
            <p>An approval request was sent to <strong>${counterpartyEmail ?? "the counterparty"}</strong>.</p>
            <p>You'll be notified once they approve and fund the exwadda account.</p>`,
            "View Transaction", txDetailUrl
          )
        );
      }
    }

    // ── FUNDED ────────────────────────────────────────────────────────────────
    if (emailEvent === "funded") {
      const sellerEmail = sellerProfile?.email ?? tx.seller_email;
      const buyerEmail = buyerProfile?.email ?? tx.buyer_email;

      if (sellerEmail) {
        await sendEmail(RESEND_API_KEY, sellerEmail,
          `Transaction Funded — Release Your Product: ${tx.title}`,
          emailWrap(
            "💰 Exwadda Funded — Action Required",
            `<p>Great news! KES ${numAmount.toLocaleString()} is now locked in exwadda for <strong>${tx.title}</strong>.</p>
            <p>Please release your product or service to the buyer. Once they confirm receipt, the funds will be released to your wallet.</p>
            <table style="width:100%;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;border-collapse:collapse;margin:16px 0;">
              <tr><td style="padding:6px 8px;color:#166534;">Amount in escrow</td><td style="padding:6px 8px;font-weight:bold;color:#16a34a;">KES ${numAmount.toLocaleString()}</td></tr>
              <tr><td style="padding:6px 8px;color:#166534;">Transaction</td><td style="padding:6px 8px;">${tx.title}</td></tr>
            </table>`,
            "Go to Dashboard", txDetailUrl
          )
        );
      }

      if (buyerEmail) {
        await sendEmail(RESEND_API_KEY, buyerEmail,
          `Transaction Approved & Funded: ${tx.title}`,
          emailWrap(
            "Transaction Funded ✅",
            `<p>Your payment of KES ${total.toLocaleString()} is now held in exwadda for <strong>${tx.title}</strong>.</p>
            <p>The seller has been notified to release the product/service. You'll be notified once they do.</p>`,
            "Track Transaction", txDetailUrl
          )
        );
      }
    }

    // ── APPROVED LOW BALANCE ──────────────────────────────────────────────────
    if (emailEvent === "approved_low_balance") {
      const buyerEmail = buyerProfile?.email ?? tx.buyer_email;
      const buyerTotal = tx.fee_payer === "buyer" ? total : tx.fee_payer === "split" ? numAmount + Math.round(fee / 2) : numAmount;

      if (buyerEmail) {
        await sendEmail(RESEND_API_KEY, buyerEmail,
          `Action Required: Fund Transaction — ${tx.title}`,
          emailWrap(
            "⚠️ Insufficient Wallet Balance",
            `<p>Hi ${buyerProfile?.first_name ?? ""},</p>
            <p>You approved <strong>${tx.title}</strong> but your wallet has insufficient funds.</p>
            <table style="width:100%;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px;border-collapse:collapse;margin:16px 0;">
              <tr><td style="padding:6px 8px;color:#991b1b;">Required</td><td style="padding:6px 8px;font-weight:bold;color:#dc2626;">KES ${buyerTotal.toLocaleString()}</td></tr>
            </table>
            <p>Please top up your ExWadda wallet to fund your exwadda account and complete the transaction.</p>`,
            "Fund Your Transaction", txDetailUrl, "#f59e0b"
          )
        );
      }
    }

    // ── DISPUTED ─────────────────────────────────────────────────────────────
    if (emailEvent === "disputed") {
      const ADMIN_EMAIL = Deno.env.get("ADMIN_EMAIL") ?? "jramtechnologies@gmail.com";
      const disputeReason = tx.dispute_reason ?? body.reason ?? "No reason provided";

      // Fetch both parties' full profiles
      const buyerName = buyerProfile ? `${buyerProfile.first_name ?? ""} ${buyerProfile.last_name ?? ""}`.trim() : "Unknown";
      const sellerName = sellerProfile ? `${sellerProfile.first_name ?? ""} ${sellerProfile.last_name ?? ""}`.trim() : "Unknown";
      const buyerEmail = buyerProfile?.email ?? tx.buyer_email ?? "N/A";
      const sellerEmail = sellerProfile?.email ?? tx.seller_email ?? "N/A";
      const buyerPhone = buyerProfile?.phone ?? tx.buyer_phone ?? "N/A";
      const sellerPhone = sellerProfile?.phone ?? tx.seller_phone ?? "N/A";

      // Full details to admin
      await sendEmail(RESEND_API_KEY, ADMIN_EMAIL,
        `🚨 Dispute Raised: ${tx.title} — Action Required`,
        emailWrap(
          "🚨 Dispute Raised — Admin Action Required",
          `<p>A dispute has been raised on transaction <strong>${tx.title}</strong>. Please review and contact both parties.</p>
          <table style="width:100%;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:0;border-collapse:collapse;margin:16px 0;">
            <tr style="background:#fee2e2;"><td colspan="2" style="padding:10px 12px;font-weight:bold;color:#991b1b;">Transaction Details</td></tr>
            <tr><td style="padding:8px 12px;color:#6b7280;width:40%;">Title</td><td style="padding:8px 12px;font-weight:bold;">${tx.title}</td></tr>
            <tr><td style="padding:8px 12px;color:#6b7280;">Amount</td><td style="padding:8px 12px;font-weight:bold;color:#dc2626;">KES ${numAmount.toLocaleString()}</td></tr>
            <tr><td style="padding:8px 12px;color:#6b7280;">Status</td><td style="padding:8px 12px;">Disputed</td></tr>
            <tr><td style="padding:8px 12px;color:#6b7280;">Transaction ID</td><td style="padding:8px 12px;font-size:12px;">${tx.id}</td></tr>
            <tr><td style="padding:8px 12px;color:#6b7280;">Dispute Reason</td><td style="padding:8px 12px;color:#dc2626;font-weight:bold;">${disputeReason}</td></tr>
            <tr style="background:#fee2e2;"><td colspan="2" style="padding:10px 12px;font-weight:bold;color:#991b1b;">Buyer Details</td></tr>
            <tr><td style="padding:8px 12px;color:#6b7280;">Name</td><td style="padding:8px 12px;font-weight:bold;">${buyerName}</td></tr>
            <tr><td style="padding:8px 12px;color:#6b7280;">Email</td><td style="padding:8px 12px;">${buyerEmail}</td></tr>
            <tr><td style="padding:8px 12px;color:#6b7280;">Phone</td><td style="padding:8px 12px;">${buyerPhone}</td></tr>
            <tr style="background:#fee2e2;"><td colspan="2" style="padding:10px 12px;font-weight:bold;color:#991b1b;">Seller Details</td></tr>
            <tr><td style="padding:8px 12px;color:#6b7280;">Name</td><td style="padding:8px 12px;font-weight:bold;">${sellerName}</td></tr>
            <tr><td style="padding:8px 12px;color:#6b7280;">Email</td><td style="padding:8px 12px;">${sellerEmail}</td></tr>
            <tr><td style="padding:8px 12px;color:#6b7280;">Phone</td><td style="padding:8px 12px;">${sellerPhone}</td></tr>
          </table>
          <p style="color:#dc2626;font-weight:bold;">Please contact both parties within 24 hours to resolve this dispute.</p>`,
          "View Transaction", txDetailUrl, "#dc2626"
        )
      );

      // Notify all participants
      for (const email of participantEmails) {
        await sendEmail(RESEND_API_KEY, email,
          `Dispute Raised: ${tx.title}`,
          emailWrap(
            "⚠️ Dispute Raised",
            `<p>A dispute has been raised for transaction <strong>${tx.title}</strong>.</p>
            <p>The ExWadda support team will review the case and contact both parties within 24 hours to resolve the issue.</p>
            <p style="color:#6b7280;">Dispute reason: <em>${disputeReason}</em></p>`,
            "View Transaction", txDetailUrl, "#dc2626"
          )
        );
      }
    }

    // ── RELEASED ─────────────────────────────────────────────────────────────
    if (emailEvent === "released") {
      for (const email of participantEmails) {
        await sendEmail(RESEND_API_KEY, email,
          `Transaction Complete: ${tx.title}`,
          emailWrap(
            "Transaction Complete ✅",
            `<p>Transaction <strong>${tx.title}</strong> has been completed successfully.</p>
            <p>Funds have been released to the seller. Thank you for using ExWadda!</p>`,
            "View Dashboard", dashboardUrl
          )
        );
      }
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error("send-transaction-email error:", err);
    return new Response(JSON.stringify({ error: err?.message ?? "Internal server error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});