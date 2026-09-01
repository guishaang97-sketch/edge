// notify-new-ticket and scheduled-checks are called by other functions /
// Supabase's cron scheduler, not directly by end users — they don't need
// --no-verify-jwt's usual "anyone can call this" exposure. This is a cheap
// shared-secret check so a random person with the URL can't trigger a wave
// of push/email/Telegram sends.
//
// Set INTERNAL_FN_SECRET as an Edge Function secret (any long random
// string), and pass the same value as the `x-internal-secret` header from
// whatever calls these functions.

export function checkInternalSecret(req: Request): boolean {
  const expected = Deno.env.get("INTERNAL_FN_SECRET");
  if (!expected) {
    console.error("INTERNAL_FN_SECRET not configured — refusing to run.");
    return false;
  }
  return req.headers.get("x-internal-secret") === expected;
}
