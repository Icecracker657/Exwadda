import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version",
};

const COMMISSION_RATE = 0.03; // 3% platform fee

async function sendEmail(
  resendKey: string,
  to: string,
  subject: string,
  html: string
) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${resendKey}`,
    },
    body: JSON.stringify({
      from: "ExWadda <support@exwadda.co.ke>",
      to: [to],
      subject,
      html,
    }),
  });
  if (!res.ok) {
    const err = await res.json();
    console.error("Email send error:", err);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 1. Authenticate user
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
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
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body = await req.json();
    const {
      role,
      counterpartyEmail,
      counterpartyPhone,
      buyerEmail,
      buyerPhone,
      sellerEmail,
      sellerPhone,
      title,
      description,
      category,
      amount,
      feePayer,
      deadline,
      brokerCommission,
    } = body;

    // 2. Validate required fields
    if (!title || !category || !amount || Number(amount) <= 0) {
      return new Response(
        JSON.stringify({ error: "Title, category, and a positive amount are required." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (role === "broker") {
      if (!buyerEmail || !sellerEmail) {
        return new Response(
          JSON.stringify({ error: "Broker transactions require buyer and seller emails." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    } else {
      if (!counterpartyEmail) {
        return new Response(
          JSON.stringify({ error: "Counterparty email is required." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // 3. Compute fee at 3%
    const numAmount = Number(amount);
    const fee = Math.round(numAmount * COMMISSION_RATE);
    const total = numAmount + fee;

    // 4. Generate secure approval token
    const tokenBytes = new Uint8Array(32);
    crypto.getRandomValues(tokenBytes);
    const approvalToken = Array.from(tokenBytes).map(b => b.toString(16).padStart(2, '0')).join('');
    const tokenExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

    // 5. Build transaction record
    const txData: Record<string, any> = {
      created_by: user.id,
      role_in_transaction: role || "buyer",
      counterparty_email: role === "broker" ? buyerEmail : counterpartyEmail,
      counterparty_phone: role === "broker" ? (buyerPhone || null) : (counterpartyPhone || null),
      seller_email: role === "broker" ? sellerEmail : (role === "buyer" ? counterpartyEmail : null),
      buyer_email: role === "broker" ? buyerEmail : (role === "seller" ? counterpartyEmail : null),
      seller_phone: role === "broker" ? (sellerPhone || null) : null,
      buyer_phone: role === "broker" ? (buyerPhone || null) : null,
      title,
      description: description || null,
      category,
      amount: numAmount,
      fee,
      fee_payer: feePayer || "buyer",
      total,
      delivery_deadline: deadline || null,
      broker_commission: role === "broker" ? (Number(brokerCommission) || 0) : 0,
      approval_token: approvalToken,
      approval_token_expires_at: tokenExpiry,
      status: "pending_approval",
    };

    // Assign role IDs
    if (role === "buyer") txData.buyer_id = user.id;
    else if (role === "seller") txData.seller_id = user.id;
    else if (role === "broker") txData.broker_id = user.id;
    if (role === "broker") txData.broker_email = body.brokerEmail ?? null;

    // 6. Insert transaction using service role (bypasses the No direct status updates policy for INSERT)
    const { data: tx, error: txError } = await serviceClient
      .from("transactions")
      .insert(txData)
      .select()
      .single();

    if (txError) {
      console.error("Transaction insert error:", JSON.stringify(txError));
      return new Response(JSON.stringify({ error: txError.message, details: txError }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    console.log("Transaction inserted successfully:", tx.id);

    // 7. Get creator profile for email
    const { data: creator, error: creatorError } = await serviceClient
      .from("profiles")
      .select("first_name, last_name, email")
      .eq("user_id", user.id)
      .single();

    if (creatorError) {
      console.error("Profile fetch error:", creatorError);
    }

    const creatorName = creator ? `${creator.first_name} ${creator.last_name}`.trim() : "Someone";
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const approvalUrl = `${supabaseUrl}/functions/v1/approve-transaction?token=${tx.approval_token}&transaction_id=${tx.id}`;
    const dashboardUrl = `${Deno.env.get("SITE_URL") || "https://exwadda.co.ke"}/dashboard`;

    const feePayerLabel = feePayer === "split" ? "Split 50/50" : feePayer === "buyer" ? "Buyer pays" : "Seller pays";

    const approvalEmailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 20px;">
          <h1 style="color: #16a34a;">ExWadda</h1>
          <p style="color: #52525b;">Secure Escrow Platform</p>
        </div>
        <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 12px; padding: 24px;">
          <h2 style="color: #15803d; margin-top: 0;">Transaction Approval Required</h2>
          <p><strong>${creatorName}</strong> has created an escrow transaction and needs your approval:</p>
          <div style="background: white; border-radius: 8px; padding: 16px; margin: 16px 0;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr><td style="color: #6b7280; padding: 6px 0;">Title</td><td style="font-weight: bold;">${tx.title}</td></tr>
              <tr><td style="color: #6b7280; padding: 6px 0;">Category</td><td>${tx.category}</td></tr>
              <tr><td style="color: #6b7280; padding: 6px 0;">Amount</td><td style="font-weight: bold; color: #16a34a;">KES ${numAmount.toLocaleString()}</td></tr>
              <tr><td style="color: #6b7280; padding: 6px 0;">Platform Fee (3%)</td><td>KES ${fee.toLocaleString()} (${feePayerLabel})</td></tr>
              <tr><td style="color: #6b7280; padding: 6px 0;">Total</td><td style="font-weight: bold;">KES ${total.toLocaleString()}</td></tr>
              ${tx.delivery_deadline ? `<tr><td style="color: #6b7280; padding: 6px 0;">Deadline</td><td>${tx.delivery_deadline}</td></tr>` : ""}
              ${description ? `<tr><td style="color: #6b7280; padding: 6px 0;">Description</td><td>${description}</td></tr>` : ""}
            </table>
          </div>
          <div style="text-align: center; margin: 24px 0;">
            <a href="${approvalUrl}" style="display: inline-block; background: #16a34a; color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px;">
              ✅ Approve & Go to Dashboard
            </a>
          </div>
          <p style="color: #6b7280; font-size: 13px; text-align: center;">
            This approval link expires in 7 days. Approving will deduct the required amount from the buyer's ExWadda wallet.
          </p>
        </div>
        <p style="color: #9ca3af; font-size: 12px; text-align: center; margin-top: 16px;">
          If you did not expect this, please ignore this email.
        </p>
      </div>
    `;

    // 8. Send approval email to counterparty
    if (RESEND_API_KEY) {
      const toEmail = role === "broker" ? buyerEmail : counterpartyEmail;
      await sendEmail(
        RESEND_API_KEY,
        toEmail,
        `Action Required: Approve Transaction — ${tx.title}`,
        approvalEmailHtml
      );

      // Also notify the creator
      const creatorNotifHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h1 style="color: #16a34a;">ExWadda</h1>
          <h2>Transaction Created Successfully</h2>
          <p>Hi ${creatorName},</p>
          <p>Your transaction <strong>${tx.title}</strong> has been created. An approval request has been sent to <strong>${toEmail}</strong>.</p>
          <div style="background: #f4f4f5; padding: 16px; border-radius: 8px;">
            <p><strong>Amount:</strong> KES ${numAmount.toLocaleString()}</p>
            <p><strong>Platform Fee (3%):</strong> KES ${fee.toLocaleString()}</p>
            <p><strong>Status:</strong> Pending Approval</p>
          </div>
          <p><a href="${dashboardUrl}" style="color: #16a34a;">View on Dashboard →</a></p>
        </div>
      `;

      const creatorEmail = creator?.email || user?.email || null;
      console.log("Creator email resolved:", creatorEmail ? "found" : "not found");
      if (creatorEmail) {
        await sendEmail(RESEND_API_KEY, creatorEmail, `Transaction Created: ${tx.title}`, creatorNotifHtml);
      }

      // For broker: also notify seller
      if (role === "broker" && sellerEmail) {
        const sellerNotifHtml = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <h1 style="color: #16a34a;">ExWadda</h1>
            <h2>You're Part of an Escrow Transaction</h2>
            <p>A broker has set up an escrow transaction involving you as the seller.</p>
            <div style="background: #f4f4f5; padding: 16px; border-radius: 8px;">
              <p><strong>Transaction:</strong> ${tx.title}</p>
              <p><strong>Amount:</strong> KES ${numAmount.toLocaleString()}</p>
              <p><strong>Broker:</strong> ${creatorName}</p>
            </div>
            <p>Once the buyer approves and funds the escrow, you will be notified to release your product/service.</p>
            <p><a href="${dashboardUrl}" style="color: #16a34a;">View on Dashboard →</a></p>
          </div>
        `;
        await sendEmail(RESEND_API_KEY, sellerEmail, `Escrow Transaction: ${tx.title}`, sellerNotifHtml);
      }
    }

    return new Response(
      JSON.stringify({ success: true, transaction: tx }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("create-transaction error:", err);
    return new Response(
      JSON.stringify({ error: err.message || "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});