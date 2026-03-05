# ExWadda Testing Guide

## Before You Can Test — Required Setup

### Step 1: Set Supabase Edge Function Secrets
Go to: **Supabase Dashboard → Project Settings → Edge Functions → Manage secrets**

Add these secrets (copy exact names):
```
RESEND_API_KEY        = re_99CsnKnJ_HmRSy5wNYLs65oqT93DZdwtd
SITE_URL              = https://exwadda.co.ke
ADMIN_EMAIL           = jramtechnologies@gmail.com
DARAJA_CONSUMER_KEY   = FTn4kjYYhmGU1J2508Ozg7zglTHDTdwnAlc7sJKzVHgENNbe
DARAJA_CONSUMER_SECRET= 7HQL4Henf2kMnoTZCDvotOUDjSkC1e7SO1n554NWATMmn7J9280dDPmIkPbr94Kd
DARAJA_SHORTCODE      = 174379
DARAJA_PASSKEY        = bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919
DARAJA_CALLBACK_SECRET= generate-with: openssl rand -hex 32
DARAJA_ENV            = sandbox
DARAJA_SKIP_IP_CHECK  = true
```

### Step 2: Deploy Edge Functions
```bash
supabase login
supabase link --project-ref ruhebxgmdbbmnkfhsqhc
supabase functions deploy
```

### Step 3: Run Migrations
```bash
supabase db push
```

---

## ⚠️ Email Limitation During Testing

The code currently uses `onboarding@resend.dev` as the sender address.

**Resend's free tier restriction:** When using `onboarding@resend.dev`, emails can ONLY
be delivered to the email address that owns your Resend account.

Your Resend account email (from the API key) is: **jramtechnologies@gmail.com**

### What this means for testing:
- **Registration OTP**: Use `jramtechnologies@gmail.com` as your test email → OTP will arrive ✅
- **Transaction approval email**: Use `jramtechnologies@gmail.com` as counterparty email → email will arrive ✅
- **Any other email**: Resend will silently drop it during testing ❌

### To send to ANY email (production):
1. Go to [resend.com/domains](https://resend.com/domains)
2. Add `exwadda.co.ke`
3. Add the DNS TXT records Resend gives you to your domain registrar
4. Wait for verification (5–30 minutes)
5. Change `onboarding@resend.dev` back to `noreply@exwadda.co.ke` in all edge functions
6. Redeploy: `supabase functions deploy`

---

## Testing Checklist

### ✅ Register & Verify
1. Go to `/register`
2. Fill in details — use `jramtechnologies@gmail.com` as your email
3. Click "Send Verification Code"
4. Check your Gmail inbox for the 6-digit OTP
5. Enter the OTP and click "Verify & Activate Account"
6. You should be redirected to `/dashboard`

### ✅ Login
1. Go to `/login`
2. Use the email and password you registered with
3. Should redirect to `/dashboard`

### ✅ Create Transaction & Receive Approval Email
1. Click "New Transaction" on dashboard
2. Fill in details:
   - **Your role**: Buyer
   - **Counterparty email**: `jramtechnologies@gmail.com` (same email, for testing)
   - **Title**: Test Transaction
   - **Amount**: 1000
3. Click "Create & Send Approval Request"
4. Check `jramtechnologies@gmail.com` inbox for approval email
5. Click the "Approve & Go to Dashboard" button in the email
6. Transaction status changes to "funded"

### ✅ Transaction Flow After Approval
1. **Seller** (or same user): Goes to transaction detail → clicks "Mark as Released"
2. **Buyer**: Clicks "Confirm Receipt"  
3. **Buyer**: Clicks "Release Funds to Seller"
4. Transaction status becomes "released"

---

## Common Errors & Fixes

| Error | Cause | Fix |
|-------|-------|-----|
| "Failed to send request to edge function" | Function not deployed | Run `supabase functions deploy` |
| "Email service not configured" | RESEND_API_KEY secret not set | Set it in Supabase Dashboard |
| OTP email not arriving | Wrong email address used | Must use `jramtechnologies@gmail.com` during testing |
| "Invalid or expired code" | OTP expired (10 min limit) | Click "Resend code" |
| Approval link not working | Function not deployed | Run `supabase functions deploy` |
| Dashboard shows empty data | RLS policies not applied | Run `supabase db push` |

---

## Funding Your Account (Add Funds)

### How it works
1. Click **Add Funds** on the dashboard
2. Enter your M-Pesa phone number and amount
3. Click **Deposit via M-Pesa** — an STK push is sent to Safaricom
4. Your phone shows an M-Pesa PIN prompt — enter your PIN
5. Safaricom calls back the system to confirm payment
6. Your wallet balance updates automatically (dialog polls every 3 seconds)

### ⚠️ Sandbox testing note
The sandbox STK push **simulates** the prompt but **does not** actually charge your M-Pesa. In sandbox mode you can trigger a fake successful callback using the Safaricom Developer Portal simulator at: https://developer.safaricom.co.ke/test-credentials

### For real M-Pesa testing
- Change `DARAJA_ENV=sandbox` → `DARAJA_ENV=production` in your Supabase secrets
- Use a real Safaricom number registered on the Daraja production portal
- Your Shortcode and Passkey must be production-approved

---

## Withdrawing Funds

### How it works
1. Click **Withdraw** on the dashboard
2. Enter amount and your M-Pesa number
3. Click **Withdraw to M-Pesa**
4. Your wallet balance is immediately deducted
5. You receive a confirmation email
6. Admin receives a notification email to process the M-Pesa transfer manually

### ⚠️ Important — B2C is not yet automatic
Daraja B2C (paying out to M-Pesa) requires a **separate Safaricom application** from C2B (receiving payments). This requires:
- Apply at: https://developer.safaricom.co.ke
- Request B2C API access for your shortcode
- Safaricom reviews and approves (1–2 weeks)
- Once approved, update `withdraw-funds` function with the B2C API call

**Until then**: Admin manually sends M-Pesa to the user's phone within 24 hours of each withdrawal request. The admin gets an email with all details each time someone withdraws.

