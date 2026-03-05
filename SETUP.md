# ExWadda — Environment & Deployment Setup

## Where do my environment variables go?

### 1. Frontend variables (`.env.local` in project root)
Only `VITE_` prefixed variables are needed here:
```
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=eyJ...
```
These are already in your `.env` file. **Never put secret keys here** — they're exposed to the browser.

---

### 2. Edge Function secrets (Supabase Dashboard)
Go to: **Supabase Dashboard → Project Settings → Edge Functions → Manage secrets**

Add each of these:

| Secret Name | Value |
|---|---|
| `RESEND_API_KEY` | `re_xxxxx` (from resend.com) |
| `DARAJA_CONSUMER_KEY` | From Safaricom Daraja portal |
| `DARAJA_CONSUMER_SECRET` | From Safaricom Daraja portal |
| `DARAJA_SHORTCODE` | Your M-Pesa shortcode (sandbox: `174379`) |
| `DARAJA_PASSKEY` | From Safaricom Daraja portal |
| `DARAJA_CALLBACK_SECRET` | Run `openssl rand -hex 32` to generate |
| `DARAJA_ENV` | `sandbox` (change to `production` when live) |
| `SITE_URL` | `https://exwadda.co.ke` |
| `ADMIN_EMAIL` | `admin@exwadda.co.ke` |

**Note:** `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are automatically injected by Supabase — do NOT set them manually.

---

### 3. Local development (optional)
Create `supabase/.env` (gitignored):
```
DARAJA_CONSUMER_KEY=xxx
DARAJA_CONSUMER_SECRET=xxx
...
```
Then run: `supabase functions serve --env-file supabase/.env`

---

## What was fixed

### ✅ 1. Daraja Callback (`daraja-callback/index.ts`)
- **Fixed**: Secret now read from URL query param (`?secret=...`) since Safaricom does NOT forward custom headers — the old header-based check never actually worked
- **Fixed**: Invalid secret returns 200 (so Safaricom doesn't retry) but exits without processing — previously it still processed the payload
- **Added**: `deposit_suspicious` type for amount mismatch cases (instead of silently doing nothing)
- **Added**: Better logging for all failure cases

### ✅ 2. Daraja STK Push (`daraja-stk-push/index.ts`)
- **Fixed**: Callback URL now embeds the secret as a query param (matching the callback fix above)
- **Added**: `DARAJA_ENV` switch — set to `production` to point to `api.safaricom.co.ke` instead of sandbox
- **Fixed**: Phone regex updated to also accept `0111xxxxxx` / `2541xxxxxxxx` (Airtel/Faiba numbers on M-Pesa)

### ✅ 3. Wallet Validation (`withdraw-funds/index.ts`)
- **Added**: Kenyan phone number validation (same regex as STK push)
- **Added**: Balance pre-check with human-readable error before attempting the atomic deduction
- **Added**: Min/max withdrawal limits

### ✅ 4. Email (`send-transaction-email/index.ts`)
- **Fixed**: Auth guard — rejects unauthenticated calls with 401
- **Fixed**: `sendEmail()` now validates recipient email before sending (no crashes on null emails)
- **Fixed**: RESEND_API_KEY missing now returns 200 with a warning (doesn't crash other flows)
- **Added**: `approved_low_balance` event type for the insufficient-funds approval case
- **Added**: `funded` event type to notify seller to release product

### ✅ 5. RLS Hardening (`migrations/20260224200000_rls_hardening_final.sql`)
- **Added**: `has_role()` function definition (was referenced but never defined!)
- **Fixed**: `wallets` table now has explicit SELECT policy (users see only their own)
- **Fixed**: `wallet_transactions` SELECT policy (users see only their own)
- **Fixed**: `admin_disputes_view` recreated with `security_invoker = true` so RLS on base tables is enforced
- **Hardened**: `add_wallet_funds` and `withdraw_wallet_funds` RPCs now REVOKE execute from `authenticated` — only callable by `service_role`
- **Added**: Performance indexes on hot columns
