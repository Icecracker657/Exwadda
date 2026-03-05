/**
 * Shared ExWadda email template.
 * All emails use support@exwadda.co.ke and consistent branding.
 */

export const FROM = "ExWadda <support@exwadda.co.ke>";
export const SUPPORT_EMAIL = "support@exwadda.co.ke";

export function emailHtml(opts: {
  title: string;
  preheader?: string;
  body: string;
  ctaText?: string;
  ctaUrl?: string;
  ctaColor?: string;
  footerNote?: string;
}): string {
  const { title, preheader, body, ctaText, ctaUrl, ctaColor = "#16a34a", footerNote } = opts;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  ${preheader ? `<span style="display:none;max-height:0;overflow:hidden;">${preheader}</span>` : ""}
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:white;border-radius:12px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.08);">
        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#16a34a,#15803d);padding:28px 32px;text-align:center;">
            <table cellpadding="0" cellspacing="0" style="margin:0 auto;">
              <tr>
                <td style="padding-right:10px;vertical-align:middle;">
                  <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 100 100">
                    <path d="M50 5 L90 20 L90 55 C90 75 72 90 50 97 C28 90 10 75 10 55 L10 20 Z" fill="rgba(255,255,255,0.25)"/>
                    <text x="50" y="65" font-family="Arial" font-size="42" font-weight="bold" fill="white" text-anchor="middle">E</text>
                  </svg>
                </td>
                <td style="vertical-align:middle;">
                  <span style="font-size:24px;font-weight:bold;color:white;letter-spacing:-0.5px;">ExWadda</span>
                </td>
              </tr>
            </table>
            <p style="color:rgba(255,255,255,0.85);margin:8px 0 0;font-size:13px;">Kenya's Trusted Escrow Platform</p>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:32px;">
            <h1 style="margin:0 0 20px;font-size:22px;font-weight:bold;color:#111827;">${title}</h1>
            <div style="color:#374151;font-size:15px;line-height:1.7;">
              ${body}
            </div>
            ${ctaText && ctaUrl ? `
            <div style="text-align:center;margin:28px 0 8px;">
              <a href="${ctaUrl}" style="display:inline-block;background:${ctaColor};color:white;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:15px;">${ctaText}</a>
            </div>` : ""}
            ${footerNote ? `<p style="color:#9ca3af;font-size:12px;margin-top:20px;">${footerNote}</p>` : ""}
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:20px 32px;text-align:center;">
            <p style="margin:0;color:#6b7280;font-size:12px;">
              © ${new Date().getFullYear()} ExWadda Ltd · Kenya<br>
              Questions? <a href="mailto:support@exwadda.co.ke" style="color:#16a34a;">support@exwadda.co.ke</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export async function sendEmail(resendKey: string, to: string, subject: string, html: string): Promise<void> {
  if (!to?.includes("@")) return;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${resendKey}` },
      body: JSON.stringify({ from: FROM, to: [to], subject, html }),
    });
    if (!res.ok) console.error("Email send failed:", await res.text());
  } catch (e) { console.error("sendEmail error:", e); }
}
