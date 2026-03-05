/**
 * Official Safaricom M-Pesa API IP ranges for callback whitelisting.
 * Source: Safaricom Developer Portal (https://developer.safaricom.co.ke)
 * Last updated: 2026-02
 *
 * IMPORTANT: Verify these against the current Safaricom developer portal
 * before going to production. Safaricom occasionally updates their IPs.
 */

// Production Safaricom IP ranges (CIDR notation)
export const SAFARICOM_PRODUCTION_CIDRS = [
  "196.201.214.0/24",
  "196.201.214.96/28",
  "196.201.214.128/28",
  "196.201.216.0/24",
  "196.201.217.0/24",
  "196.201.218.0/24",
  "192.168.32.0/24", // internal (keep for reference)
];

// Sandbox Safaricom IPs (Safaricom sandbox routes through similar ranges)
export const SAFARICOM_SANDBOX_CIDRS = [
  "196.201.214.0/24",
  "196.201.214.96/28",
];

// IP ranges that are always blocked regardless of env
export const ALWAYS_BLOCK_CIDRS: string[] = [];

/**
 * Convert a CIDR string to a numeric range for fast comparison.
 */
function cidrToRange(cidr: string): { start: number; end: number } {
  const [ip, bits] = cidr.split("/");
  const mask = ~((1 << (32 - parseInt(bits))) - 1) >>> 0;
  const start = ipToInt(ip) & mask;
  const end = start | (~mask >>> 0);
  return { start, end };
}

function ipToInt(ip: string): number {
  return ip
    .split(".")
    .reduce((acc, octet) => (acc << 8) + parseInt(octet), 0) >>> 0;
}

/**
 * Returns true if the given IP is within any of the provided CIDR ranges.
 */
export function isIpInCidrs(ip: string, cidrs: string[]): boolean {
  try {
    const ipInt = ipToInt(ip);
    return cidrs.some((cidr) => {
      const { start, end } = cidrToRange(cidr);
      return ipInt >= start && ipInt <= end;
    });
  } catch {
    return false;
  }
}

/**
 * Validate that a callback request comes from Safaricom's known IP ranges.
 * Returns { allowed, ip } — IP is extracted from trusted proxy headers.
 *
 * Supabase Edge Functions run behind Deno Deploy's proxy, which sets
 * x-real-ip or x-forwarded-for reliably.
 */
export function validateCallbackIp(req: Request): {
  allowed: boolean;
  ip: string | null;
  reason?: string;
} {
  const env = Deno.env.get("DARAJA_ENV") ?? "sandbox";

  // Extract real IP from proxy headers
  const xRealIp = req.headers.get("x-real-ip");
  const xForwardedFor = req.headers.get("x-forwarded-for");

  // x-forwarded-for can be a comma-separated list; first IP is the client
  const ip = xRealIp ?? xForwardedFor?.split(",")[0]?.trim() ?? null;

  // If IP whitelisting is disabled via env var (for local dev), skip check
  if (Deno.env.get("DARAJA_SKIP_IP_CHECK") === "true") {
    console.warn("WARN: DARAJA_SKIP_IP_CHECK=true — IP validation bypassed");
    return { allowed: true, ip };
  }

  if (!ip) {
    return {
      allowed: false,
      ip: null,
      reason: "Cannot determine client IP — request missing proxy headers",
    };
  }

  const cidrs =
    env === "production"
      ? SAFARICOM_PRODUCTION_CIDRS
      : SAFARICOM_SANDBOX_CIDRS;

  // Always-block check first
  if (isIpInCidrs(ip, ALWAYS_BLOCK_CIDRS)) {
    return { allowed: false, ip, reason: "IP is in always-block list" };
  }

  const allowed = isIpInCidrs(ip, cidrs);
  return {
    allowed,
    ip,
    reason: allowed ? undefined : `IP ${ip} not in Safaricom ${env} whitelist`,
  };
}
