import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

async function sendEmail(resendKey: string, to: string, subject: string, html: string) {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${resendKey}` },
      body: JSON.stringify({ from: "ExWadda <support@exwadda.co.ke>", to: [to], subject, html }),
    });
    if (!res.ok) console.error("Email failed:", await res.json());
  } catch (e) { console.error("sendEmail error:", e); }
}

function htmlPage(title: string, message: string, success = true): Response {
  const color = success ? "#16a34a" : "#dc2626";
  const icon = success ? "✅" : "❌";
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${title}</title>
    <style>*{box-sizing:border-box}body{font-family:Arial,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f4f4f5;padding:16px}.card{background:white;padding:40px;border-radius:16px;max-width:480px;width:100%;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,.12)}.icon{font-size:48px;margin-bottom:16px}h1{color:${color};margin:0 0 16px}p{color:#52525b;line-height:1.6;margin:0}</style>
    </head><body><div class="card"><div class="icon">${icon}</div><h1>${title}</h1><p>${message}</p></div></body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  const txId = url.searchParams.get("id");

  if (!token || !txId) return htmlPage("Invalid Link", "Missing parameters.", false);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Find withdrawal by ID and token
  const { data: wtx } = await supabase
    .from("wallet_transactions")
    .select("*")
    .eq("id", txId)
    .eq("idempotency_key", token)
    .single();

  if (!wtx) {
    const { data: existing } = await supabase
      .from("wallet_transactions")
      .select("type")
      .eq("id", txId)
      .single();
    if (existing?.type === "withdrawal") {
      return htmlPage("Already Paid", "This withdrawal was already marked as paid.", true);
    }
    return htmlPage("Invalid Link", "This link is invalid or expired.", false);
  }

  if (wtx.type === "withdrawal") {
    return htmlPage("Already Paid", "This withdrawal was already marked as paid.", true);
  }

  // Mark as paid
  const { error } = await supabase
    .from("wallet_transactions")
    .update({ type: "withdrawal" })
    .eq("id", txId);

  if (error) {
    console.error("Mark paid error:", error);
    return htmlPage("Error", "Failed to update. Please try again.", false);
  }

  // Notify user
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
  const SITE_URL = Deno.env.get("SITE_URL") ?? "https://exwadda.co.ke";

  if (RESEND_API_KEY) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("email, first_name")
      .eq("user_id", wtx.user_id)
      .single();

    if (profile?.email) {
      await sendEmail(
        RESEND_API_KEY,
        profile.email,
        `M-Pesa Payment Sent: KES ${Number(wtx.amount).toLocaleString()}`,
        `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
          <h1 style="color:#16a34a;">ExWadda</h1>
          <h2>💸 Your Withdrawal Has Been Paid</h2>
          <p>Hi ${profile.first_name ?? ""},</p>
          <p>Your withdrawal of <strong>KES ${Number(wtx.amount).toLocaleString()}</strong> has been sent to <strong>${wtx.phone}</strong> via M-Pesa.</p>
          <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin:16px 0;">
            <p><strong>Amount:</strong> KES ${Number(wtx.amount).toLocaleString()}</p>
            <p><strong>M-Pesa:</strong> ${wtx.phone}</p>
            <p><strong>Status:</strong> ✅ Paid</p>
          </div>
          <a href="${SITE_URL}/dashboard" style="display:inline-block;background:#16a34a;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">View Dashboard</a>
        </div>`
      );
    }
  }

  const SITE_URL2 = Deno.env.get("SITE_URL") ?? "https://exwadda.co.ke";
return Response.redirect(`${SITE_URL2}/dashboard`, 302);
});
