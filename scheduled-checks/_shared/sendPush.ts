// Sends a Web Push notification to a single subscription. Uses the `npm:`
// specifier — Supabase Edge Functions (Deno) support importing npm packages
// directly, no bundler needed.
//
// Requires two env vars (set as Supabase Edge Function secrets):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY
// Generate a pair once with `npx web-push generate-vapid-keys` and keep the
// private key secret — never ship it to the frontend.

import webpush from "npm:web-push@3.6.7";

const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const VAPID_CONTACT_EMAIL = Deno.env.get("VAPID_CONTACT_EMAIL") ?? "mailto:admin@example.com";

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_CONTACT_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

export interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  subscription: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };
}

/**
 * Sends one push notification. Returns true on success. A 404/410 response
 * means the subscription is dead (browser unsubscribed, device reset,
 * etc.) — the caller should delete that row so we stop trying it forever.
 */
export async function sendPushToSubscription(
  sub: PushSubscriptionRow,
  payload: { title: string; body: string; url?: string },
): Promise<{ ok: boolean; expired: boolean }> {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.error("VAPID keys not configured — skipping push send.");
    return { ok: false, expired: false };
  }

  try {
    await webpush.sendNotification(sub.subscription, JSON.stringify(payload));
    return { ok: true, expired: false };
  } catch (err) {
    const statusCode = (err as { statusCode?: number })?.statusCode;
    const expired = statusCode === 404 || statusCode === 410;
    if (!expired) console.error("Push send failed:", err);
    return { ok: false, expired };
  }
}
