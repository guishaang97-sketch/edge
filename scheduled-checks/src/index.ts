// POST /scheduled-checks
// Header: x-internal-secret: <INTERNAL_FN_SECRET>
//
// Meant to run on a schedule (Supabase dashboard -> Edge Functions ->
// this function -> add a Cron Trigger, e.g. "0 * * * *" for hourly).
// Does two independent jobs each run, both idempotent (safe to run more
// than once — each ticket only ever gets one alert/email thanks to the
// *_notified_at / *_email_sent_at columns from migration 006):
//
//   1. Escalation: unclaimed tickets past their escalation_deadline that
//      haven't been flagged yet -> push to dispatchers/admins.
//   2. Closure email: tickets that have been closed for 2+ hours straight
//      (and are STILL closed — a reopen just means this simply won't match
//      the query anymore) -> one confirmation email to the customer, if
//      they gave an email address.

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
const CLOSURE_EMAIL_DELAY_HOURS = 2;

Deno.serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  // Supabase's Cron Trigger calls this with GET; allow both so it also
  // works from a manual test POST.
  if (!checkInternalSecret(req)) return jsonResponse({ error: "Unauthorized." }, 401);

  const results = { escalated: 0, closure_emails: 0, errors: [] as string[] };

  // --- 1. Escalation alerts -------------------------------------------------
  try {
    const { data: overdue, error } = await supabase
      .from("tickets")
      .select("*, machines(*)")
      .eq("status", "unclaimed")
      .is("escalation_notified_at", null)
      .lte("escalation_deadline", new Date().toISOString());

    if (error) throw error;

    if (overdue && overdue.length > 0) {
      const { data: managers } = await supabase
        .from("technicians")
        .select("id")
        .eq("active", true)
        .eq("notify_via_push", true)
        .in("role", ["dispatcher", "admin"]);

      const managerIds = (managers || []).map((m) => m.id);
      const { data: subs } = managerIds.length
        ? await supabase.from("technician_push_subscriptions").select("*").in("technician_id", managerIds)
        : { data: [] };

      for (const ticket of overdue) {
        const m = ticket.machines;
        const ticketUrl = DASHBOARD_URL ? `${DASHBOARD_URL}/tickets/${ticket.id}` : "";
        const payload = {
          title: `⚠ Overdue — ${ticket.ticket_number}`,
          body: `Still unclaimed: ${m.customer_name} (${ticket.region})`,
          url: ticketUrl,
        };

        for (const sub of subs || []) {
          await sendPushToSubscription(sub, payload);
        }

        await supabase
          .from("tickets")
          .update({ escalation_notified_at: new Date().toISOString(), escalated_at: new Date().toISOString() })
          .eq("id", ticket.id);

        await supabase.from("ticket_events").insert({
          ticket_id: ticket.id,
          event_type: "escalated",
          detail: "Escalation alert sent — still unclaimed past deadline",
        });

        results.escalated++;
      }
    }
  } catch (err) {
    console.error("Escalation check failed:", err);
    results.errors.push("escalation check failed");
  }

  // --- 2. Closure confirmation emails ---------------------------------------
  try {
    const cutoff = new Date(Date.now() - CLOSURE_EMAIL_DELAY_HOURS * 3600 * 1000).toISOString();

    const { data: closedTickets, error } = await supabase
      .from("tickets")
      .select("*, machines(*)")
      .eq("status", "closed")
      .is("closure_email_sent_at", null)
      .not("contact_email", "is", null)
      .lte("closed_at", cutoff);

    if (error) throw error;

    for (const ticket of closedTickets || []) {
      const m = ticket.machines;
      const html = `
        <p>Hi ${ticket.contact_name || "there"},</p>
        <p>Your service ticket has been closed:</p>
        <p style="font-size:18px;font-weight:700;font-family:monospace;">${ticket.ticket_number}</p>
        <p>Machine: ${m.brand} ${m.machine_model} (SN ${m.serial_number})</p>
        <p>If this issue comes back or you have questions, please reach out and reference this ticket number.</p>
        <p>— MRL Cybertec Service Department</p>
      `;
      const sent = await sendEmail(ticket.contact_email, `Ticket ${ticket.ticket_number} closed`, html);
      if (sent) {
        await supabase.from("tickets").update({ closure_email_sent_at: new Date().toISOString() }).eq("id", ticket.id);
        results.closure_emails++;
      }
    }
  } catch (err) {
    console.error("Closure email check failed:", err);
    results.errors.push("closure email check failed");
  }

  // --- 3. PM visit reminders ---------------------------------------------
  // Same idea as escalation: each transition only fires once, tracked by
  // moving pm_schedules.status forward through the state machine already
  // defined back in the original schema (upcoming -> notified_week ->
  // notified_daily -> overdue). Notifies the same way a new ticket does —
  // push + the region's Telegram group — since PM work is regional too.
  try {
    const today = new Date();
    const in7Days = new Date(today.getTime() + 7 * 86400000).toISOString().slice(0, 10);
    const tomorrow = new Date(today.getTime() + 1 * 86400000).toISOString().slice(0, 10);
    const todayStr = today.toISOString().slice(0, 10);

    async function notifyRegionForVisit(visit: {
      id: string;
      scheduled_date: string;
      machines: { region: string; customer_name: string; brand: string; machine_model: string };
      pm_contracts: { focus: string };
    }, label: string) {
      const region = visit.machines.region;
      const m = visit.machines;

      const { data: technicians } = await supabase
        .from("technicians")
        .select("id")
        .eq("active", true)
        .eq("notify_via_push", true)
        .neq("role", "viewer")
        .contains("regions_subscribed", [region]);

      if (technicians && technicians.length > 0) {
        const techIds = technicians.map((t) => t.id);
        const { data: subs } = await supabase.from("technician_push_subscriptions").select("*").in("technician_id", techIds);
        const payload = {
          title: `${label} · ${region}`,
          body: `${m.customer_name} — ${visit.pm_contracts.focus} (${m.brand} ${m.machine_model}), ${visit.scheduled_date}`,
        };
        for (const sub of subs || []) {
          const { expired } = await sendPushToSubscription(sub, payload);
          if (expired) await supabase.from("technician_push_subscriptions").delete().eq("id", sub.id);
        }
      }

      const { data: channel } = await supabase.from("region_telegram_channels").select("chat_id").eq("region", region).maybeSingle();
      if (channel?.chat_id) {
        const text =
          `🔧 <b>${label} — ${region}</b>\n` +
          `${m.customer_name} — ${visit.pm_contracts.focus}\n` +
          `${m.brand} ${m.machine_model}\n` +
          `Scheduled: ${visit.scheduled_date}`;
        await sendTelegramMessage(channel.chat_id, text);
      }
    }

    // Due within 7 days: upcoming -> notified_week
    const { data: dueWeek } = await supabase
      .from("pm_schedules")
      .select("id, scheduled_date, machines(region, customer_name, brand, machine_model), pm_contracts(focus)")
      .eq("status", "upcoming")
      .lte("scheduled_date", in7Days);
    for (const visit of dueWeek || []) {
      await notifyRegionForVisit(visit as never, "PM due this week");
      await supabase.from("pm_schedules").update({ status: "notified_week", last_notified_at: new Date().toISOString() }).eq("id", visit.id);
    }

    // Due tomorrow: notified_week -> notified_daily
    const { data: dueTomorrow } = await supabase
      .from("pm_schedules")
      .select("id, scheduled_date, machines(region, customer_name, brand, machine_model), pm_contracts(focus)")
      .eq("status", "notified_week")
      .lte("scheduled_date", tomorrow);
    for (const visit of dueTomorrow || []) {
      await notifyRegionForVisit(visit as never, "PM due tomorrow");
      await supabase.from("pm_schedules").update({ status: "notified_daily", last_notified_at: new Date().toISOString() }).eq("id", visit.id);
    }

    // Past due and never completed -> overdue (one-time alert)
    const { data: overdueVisits } = await supabase
      .from("pm_schedules")
      .select("id, scheduled_date, machines(region, customer_name, brand, machine_model), pm_contracts(focus)")
      .in("status", ["upcoming", "notified_week", "notified_daily"])
      .lt("scheduled_date", todayStr);
    for (const visit of overdueVisits || []) {
      await notifyRegionForVisit(visit as never, "⚠ PM overdue");
      await supabase.from("pm_schedules").update({ status: "overdue", last_notified_at: new Date().toISOString() }).eq("id", visit.id);
    }

  } catch (err) {
    console.error("PM reminder check failed:", err);
    results.errors.push("PM reminder check failed");
  }

  return jsonResponse({ ok: true, results });
});
