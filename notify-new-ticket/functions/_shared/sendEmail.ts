// Sends transactional email via Resend's REST API — no SDK needed, just a
// fetch call. Free tier: 100 emails/day, 3,000/month, which is far more
// than this project's ~5-10 tickets/day needs.
//
// Requires env vars (Supabase Edge Function secrets):
//   RESEND_API_KEY, EMAIL_FROM  (e.g. "MRL Cybertec <service@yourdomain.com>")
// Resend requires the "from" domain to be verified in their dashboard
// before it can send — see notify/README.md.

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const EMAIL_FROM = Deno.env.get("EMAIL_FROM") ?? "";

export async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  if (!RESEND_API_KEY || !EMAIL_FROM) {
    console.error("RESEND_API_KEY or EMAIL_FROM not configured — skipping email send.");
    return false;
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: EMAIL_FROM, to, subject, html }),
    });
    if (!res.ok) {
      console.error("Resend send failed:", await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error("Resend send error:", err);
    return false;
  }
}
