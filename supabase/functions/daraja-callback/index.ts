import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateCallbackIp } from "../_shared/safaricom-ips.ts";
import { audit } from "../_shared/audit.ts";

/**
 * daraja-callback — Safaricom STK push result handler.
 *
 * Security layers:
 *  1. IP whitelist (Safaricom IPs only) — set DARAJA_SKIP_IP_CHECK=true for sandbox
 *  2. HMAC-SHA256 via nonce — daraja-stk-push pre-signs a nonce and embeds it
 *     in the callback URL (?cid={nonce}&sig={HMAC(secret,nonce)})
 *  3. Amount verification inside the atomic RPC
 *  4. Row-locked SQL transaction (process_daraja_deposit) for idempotency
 *
 * Always returns HTTP 200 — non-200 triggers Safaricom retries.
 */

const accept = () =>
  new Response(JSON.stringify({ ResultCode: 0, ResultDesc: "Accepted" }), {
    headers: { "Content-Type": "application/json" },
  });

/** Constant-time string comparison — prevents timing attacks */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  // ── 1. IP WHITELIST ────────────────────────────────────────────────────────
  const ipResult = validateCallbackIp(req);
  const clientIp = ipResult.ip ?? "unknown";

  if (!ipResult.allowed) {
    console.error(`SECURITY: Blocked callback from IP ${clientIp}: ${ipResult.reason}`);
    return accept(); // always 200
  }

  try {
    // ── 2. HMAC VERIFICATION via nonce ───────────────────────────────────────
    const CALLBACK_SECRET = Deno.env.get("DARAJA_CALLBACK_SECRET");
    if (!CALLBACK_SECRET) {
      console.error("FATAL: DARAJA_CALLBACK_SECRET not set");
      return accept();
    }

    const url          = new URL(req.url);
    const nonce        = url.searchParams.get("cid");  // pre-signed nonce from stk-push
    const providedSig  = url.searchParams.get("sig");

    if (!nonce || !providedSig) {
      console.error(`SECURITY: Missing cid/sig from IP ${clientIp}`);
      return accept();
    }

    // Compute expected HMAC-SHA256(secret, nonce)
    const encoder  = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
      "raw", encoder.encode(CALLBACK_SECRET),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sigBuf     = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(nonce));
    const expectedSig = Array.from(new Uint8Array(sigBuf))
      .map(b => b.toString(16).padStart(2, "0")).join("");

    if (!timingSafeEqual(providedSig, expectedSig)) {
      console.error(`SECURITY: HMAC mismatch from IP ${clientIp}, nonce=${nonce}`);
      return accept();
    }

    // ── 3. PARSE BODY ────────────────────────────────────────────────────────
    const rawBody = await req.text();
    let body: any;
    try { body = JSON.parse(rawBody); } catch {
      console.error("Invalid JSON body from IP:", clientIp);
      return accept();
    }

    const callback = body?.Body?.stkCallback;
    if (!callback) {
      console.error("Missing Body.stkCallback from IP:", clientIp);
      return accept();
    }

    const resultCode:        number = callback.ResultCode;
    const checkoutRequestId: string = callback.CheckoutRequestID;

    if (!checkoutRequestId) {
      console.error("Missing CheckoutRequestID in callback body");
      return accept();
    }

    // ── 4. SUPABASE SERVICE CLIENT ───────────────────────────────────────────
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    if (resultCode === 0) {
      // ── PAYMENT SUCCESSFUL ─────────────────────────────────────────────────
      const items    = callback.CallbackMetadata?.Item ?? [];
      const getItem  = (name: string) => items.find((i: any) => i.Name === name)?.Value;

      const paidAmount   = Number(getItem("Amount") ?? 0);
      const phone        = String(getItem("PhoneNumber") ?? "");
      const mpesaReceipt = String(getItem("MpesaReceiptNumber") ?? "");

      if (paidAmount <= 0) {
        console.error("Invalid paidAmount:", paidAmount, "ID:", checkoutRequestId);
        return accept();
      }

      // ── 5. CALL ATOMIC RPC ─────────────────────────────────────────────────
      // process_daraja_deposit() does inside ONE SQL transaction:
      //   a) Idempotency key check
      //   b) SELECT FOR UPDATE on pending wallet_transaction (matched by checkoutRequestId OR nonce)
      //   c) Amount verification
      //   d) Credit wallet
      //   e) Mark transaction as deposit
      //   f) Write audit log
      const idempotencyKey = `daraja_deposit:${checkoutRequestId}`;

      const { data: rpcResult, error: rpcError } = await supabase.rpc(
        "process_daraja_deposit",
        {
          _checkout_request_id: checkoutRequestId,
          _paid_amount:         paidAmount,
          _phone:               phone,
          _mpesa_receipt:       mpesaReceipt,
          _idempotency_key:     idempotencyKey,
          // Pass nonce so RPC can also match by idempotency_key column
        }
      );

      if (rpcError) {
        console.error("CRITICAL: process_daraja_deposit failed:", rpcError.message, "ID:", checkoutRequestId);
        await audit(supabase, {
          action: "wallet_credit_failed",
          metadata: { checkoutRequestId, paidAmount, rpcError: rpcError.message, ip: clientIp },
          success: false,
          error_message: rpcError.message,
          ip: clientIp,
        });
        return accept();
      }

      const result = rpcResult as { status: string; reason?: string; user_id?: string };

      if (result?.status === "already_processed") {
        console.log("Idempotency: already processed:", checkoutRequestId);
      } else if (result?.status === "success") {
        console.log(`SUCCESS: KES ${paidAmount} credited. Receipt: ${mpesaReceipt}. User: ${result.user_id}`);
      } else if (result?.status === "error") {
        console.error(`RPC error: ${result.reason}. ID: ${checkoutRequestId}`);
      }

    } else {
      // ── PAYMENT FAILED / CANCELLED ─────────────────────────────────────────
      const reason = resultCode === 1032
        ? "cancelled by user"
        : `failed with code ${resultCode}`;

      console.log(`STK Push ${reason}: "${callback.ResultDesc}". ID: ${checkoutRequestId}`);

      // Remove pending row so user can retry immediately
      await supabase
        .from("wallet_transactions")
        .delete()
        .eq("checkout_request_id", checkoutRequestId)
        .eq("type", "deposit_pending");

      // Also try matching by nonce (idempotency_key) in case checkout_request_id wasn't stored
      await supabase
        .from("wallet_transactions")
        .delete()
        .eq("idempotency_key", nonce)
        .eq("type", "deposit_pending");

      await audit(supabase, {
        action: "daraja_callback_received",
        metadata: { checkoutRequestId, resultCode, resultDesc: callback.ResultDesc, ip: clientIp },
        success: false,
        error_message: callback.ResultDesc,
        ip: clientIp,
      });
    }

    return accept();
  } catch (err: any) {
    console.error("Unhandled daraja-callback error from IP", clientIp, ":", err);
    return accept();
  }
});
