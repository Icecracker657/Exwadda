import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface RateLimitConfig {
  key: string;          // e.g. "deposit:user_abc123"
  windowSeconds: number; // window size in seconds
  maxRequests: number;   // max requests allowed in window
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
}

/**
 * Sliding window rate limiter backed by the `rate_limits` table.
 * Uses INSERT ... ON CONFLICT to atomically increment counters.
 */
export async function checkRateLimit(
  supabase: SupabaseClient,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - config.windowSeconds * 1000);
  const windowKey = `${config.key}:${Math.floor(now.getTime() / (config.windowSeconds * 1000))}`;
  const resetAt = new Date(
    (Math.floor(now.getTime() / (config.windowSeconds * 1000)) + 1) * config.windowSeconds * 1000
  );

  const { data, error } = await supabase.rpc("increment_rate_limit", {
    _key: windowKey,
    _window_seconds: config.windowSeconds,
    _max_requests: config.maxRequests,
  });

  if (error) {
    // On error, fail open (allow request but log)
    console.error("Rate limit check error:", error);
    return { allowed: true, remaining: 1, resetAt };
  }

  const count = data?.count ?? 1;
  const allowed = count <= config.maxRequests;
  const remaining = Math.max(0, config.maxRequests - count);

  return { allowed, remaining, resetAt };
}

/**
 * Returns a standardized 429 response with Retry-After header.
 */
export function rateLimitResponse(
  result: RateLimitResult,
  corsHeaders: Record<string, string>
): Response {
  const retryAfter = Math.ceil((result.resetAt.getTime() - Date.now()) / 1000);
  return new Response(
    JSON.stringify({
      error: "Too many requests. Please slow down and try again.",
      retryAfter,
      resetAt: result.resetAt.toISOString(),
    }),
    {
      status: 429,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Retry-After": String(retryAfter),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": String(Math.floor(result.resetAt.getTime() / 1000)),
      },
    }
  );
}
