import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type AuditAction =
  | "wallet_deposit"
  | "wallet_withdrawal"
  | "wallet_escrow_hold"
  | "wallet_escrow_release"
  | "wallet_credit_failed"
  | "wallet_suspicious_amount"
  | "transaction_approved"
  | "transaction_funded"
  | "transaction_released"
  | "transaction_disputed"
  | "daraja_callback_received"
  | "daraja_callback_rejected"
  | "rate_limit_hit"
  | "ip_blocked";

export interface AuditEntry {
  action: AuditAction;
  user_id?: string | null;
  transaction_id?: string | null;
  amount?: number | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  success: boolean;
  error_message?: string | null;
}

/**
 * Write to the audit_logs table.
 * Failures are silently logged to console — audit should never crash main flow.
 */
export async function audit(
  supabase: SupabaseClient,
  entry: AuditEntry
): Promise<void> {
  try {
    const { error } = await supabase.from("audit_logs").insert({
      action: entry.action,
      user_id: entry.user_id ?? null,
      transaction_id: entry.transaction_id ?? null,
      amount: entry.amount ?? null,
      metadata: entry.metadata ?? null,
      ip: entry.ip ?? null,
      success: entry.success,
      error_message: entry.error_message ?? null,
    });
    if (error) {
      console.error("Audit log write failed:", error.message);
    }
  } catch (e) {
    console.error("Audit log exception:", e);
  }
}
