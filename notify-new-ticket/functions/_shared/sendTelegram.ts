// Sends a message to a Telegram chat (a region's group) via the Bot API —
// plain fetch, no library needed. Free, no limits worth worrying about at
// this volume.
//
// Requires an env var (Supabase Edge Function secret): TELEGRAM_BOT_TOKEN
// See notify/README.md for creating the bot via @BotFather and getting a
// group's chat ID.

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";

export async function sendTelegramMessage(chatId: string, text: string): Promise<boolean> {
  if (!TELEGRAM_BOT_TOKEN) {
    console.error("TELEGRAM_BOT_TOKEN not configured — skipping Telegram send.");
    return false;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
    if (!res.ok) {
      console.error("Telegram send failed:", await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error("Telegram send error:", err);
    return false;
  }
}
