// POST /notify-new-ticket
// Body: { ticket_id: string }
// Header: x-internal-secret: <INTERNAL_FN_SECRET>
//
// Called by intake-submit-ticket right after a ticket is created (see the
// TODO hook that used to be there). Does two independent things — a
// failure in one doesn't block the other:
//
//   1. Technicians subscribed to the ticket's region get a push
//      notification (per-person, if they've enabled it) and the region's
//      Telegram group gets a message (if one's configured).
//   2. The customer gets a one-time confirmation email with their ticket
//      number, if they gave an email address. No follow-up emails on
//      updates/resolution — just this one, and (separately) a closure
//      email from scheduled-checks if it stays closed 2+ hours.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { checkInternalSecret } from "../_shared/internalAuth.ts";
import { sendPushToSubscription } from "../_shared/sendPush.ts";
import { sendEmail } from "../_shared/sendEmail.ts";
import { sendTelegramMessage } from "../_shared/sendTelegram.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const DASHBOARD_URL = Deno.env.get("DASHBOARD_URL") ?? "";

Deno.serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") return jsonResponse({ error: "Use POST." }, 405);
  if (!checkInternalSecret(req)) return jsonResponse({ error: "Unauthorized." }, 401);

  try {
    const { ticket_id } = await req.json();
    if (!ticket_id) return jsonResponse({ error: "Missing ticket_id." }, 400);

    const { data: ticket, error: ticketError } = await supabase
      .from("tickets")
      .select("*, machines(*)")
      .eq("id", ticket_id)
      .single();

    if (ticketError || !ticket) {
      console.error(ticketError);
      return jsonResponse({ error: "Ticket not found." }, 404);
    }

    const m = ticket.machines;
    const ticketUrl = DASHBOARD_URL ? `${DASHBOARD_URL}/tickets/${ticket.id}` : "";

    const results = { push_sent: 0, push_expired: 0, telegram_sent: false, email_sent: false };

    // --- 1a. Push to subscribed technicians in this region -----------------
    const { data: technicians } = await supabase
      .from("technicians")
      .select("id")
      .eq("active", true)
      .eq("notify_via_push", true)
      .neq("role", "viewer")
      .contains("regions_subscribed", [ticket.region]);

    if (technicians && technicians.length > 0) {
      const techIds = technicians.map((t) => t.id);
      const { data: subs } = await supabase
        .from("technician_push_subscriptions")
        .select("*")
        .in("technician_id", techIds);

      const payload = {
        title: `New ticket · ${ticket.region}`,
        body: `${ticket.ticket_number} — ${m.customer_name} (${m.brand} ${m.machine_model})`,
        url: ticketUrl,
      };

      for (const sub of subs || []) {
        const { ok, expired } = await sendPushToSubscription(sub, payload);
        if (ok) results.push_sent++;
        if (expired) {
          results.push_expired++;
          await supabase.from("technician_push_subscriptions").delete().eq("id", sub.id);
        }
      }
    }

    // --- 1b. Telegram group for this region ---------------------------------
    const { data: channel } = await supabase
      .from("region_telegram_channels")
      .select("chat_id")
      .eq("region", ticket.region)
      .maybeSingle();

    if (channel?.chat_id) {
      const text =
        `🎫 <b>New ticket — ${ticket.region}</b>\n` +
        `${ticket.ticket_number}\n` +
        `${m.customer_name} — ${m.brand} ${m.machine_model}\n` +
        `SN ${m.serial_number}` +
        (ticketUrl ? `\n${ticketUrl}` : "");
      results.telegram_sent = await sendTelegramMessage(channel.chat_id, text);
    }

    // --- 2. Customer confirmation email (one-time, only if they gave one) --
    if (ticket.contact_email) {
      const html = `
        <p>Hi ${ticket.contact_name || "there"},</p>
        <p>We've received your service request. Your ticket number is:</p>
        <p style="font-size:20px;font-weight:700;font-family:monospace;">${ticket.ticket_number}</p>
        <p>Machine: ${m.brand} ${m.machine_model} (SN ${m.serial_number})</p>
        <p>A technician will reach out shortly. Please keep this ticket number for reference.</p>
        <p>— MRL Cybertec Service Department</p>
      `;
      results.email_sent = await sendEmail(ticket.contact_email, `Ticket ${ticket.ticket_number} received`, html);
    }

    return jsonResponse({ ok: true, results });
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: "Unexpected error." }, 500);
  }
});
