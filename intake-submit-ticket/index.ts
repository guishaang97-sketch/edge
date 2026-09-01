// POST /intake-submit-ticket
// Body: {
//   qr_short_id: string,
//   description: string,
//   contact_name: string,
//   contact_number: string,
//   contact_email?: string          // optional, per plan §6.3 / §9
// }
//
// Public, unauthenticated — this is the actual "customer submits the form"
// step. Runs with the service role key so it can insert into `tickets`
// without the customer needing a staff login (RLS on `tickets` only allows
// authenticated-staff inserts; this function is the deliberate bypass for
// the one legitimate anonymous write path, per the note in 001_schema.sql §14).
//
// Ticket number (MRLSRV-{year}-{00001}) and region are generated/derived by
// the database itself (see triggers `trg_set_ticket_number` and
// `trg_set_ticket_region` in 001_schema.sql) — this function does not set
// them directly.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, handleOptions, jsonResponse } from "../_shared/cors.ts";
import { computeEscalationDeadline } from "../_shared/workingHours.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

interface IntakePayload {
  qr_short_id?: string;
  description?: string;
  contact_name?: string;
  contact_number?: string;
  contact_email?: string;
}

Deno.serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return jsonResponse({ error: "Use POST." }, 405);
  }

  try {
    const payload: IntakePayload = await req.json();
    const { qr_short_id, description, contact_name, contact_number, contact_email } = payload;

    // --- validation -------------------------------------------------------
    const missing: string[] = [];
    if (!qr_short_id) missing.push("qr_short_id");
    if (!description) missing.push("description");
    if (!contact_name) missing.push("contact_name");
    if (!contact_number) missing.push("contact_number");
    if (missing.length > 0) {
      return jsonResponse({ error: `Missing required field(s): ${missing.join(", ")}` }, 400);
    }
    if (contact_email && !/^\S+@\S+\.\S+$/.test(contact_email)) {
      return jsonResponse({ error: "contact_email is not a valid email address." }, 400);
    }

    // --- resolve machine ----------------------------------------------------
    const { data: machine, error: machineError } = await supabase
      .from("machines")
      .select("id, region")
      .eq("qr_short_id", qr_short_id)
      .eq("active", true)
      .maybeSingle();

    if (machineError) {
      console.error(machineError);
      return jsonResponse({ error: "Machine lookup failed." }, 500);
    }
    if (!machine) {
      return jsonResponse({ error: "Machine not found for this QR code." }, 404);
    }

    // --- compute SLA deadline (§6.6) ----------------------------------------
    const now = new Date();
    const escalationDeadline = computeEscalationDeadline(now, 120);

    // --- create ticket -------------------------------------------------------
    const { data: ticket, error: ticketError } = await supabase
      .from("tickets")
      .insert({
        machine_id: machine.id,
        region: machine.region,
        description,
        contact_name,
        contact_number,
        contact_email: contact_email ?? null,
        escalation_deadline: escalationDeadline.toISOString(),
      })
      .select("id, ticket_number, created_at")
      .single();

    if (ticketError) {
      console.error(ticketError);
      return jsonResponse({ error: "Could not create ticket." }, 500);
    }

    // --- audit trail entry -----------------------------------------------
    const { error: eventError } = await supabase.from("ticket_events").insert({
      ticket_id: ticket.id,
      actor: null, // customer-originated, not a technician
      event_type: "note",
      detail: "Ticket created from QR intake form.",
    });
    if (eventError) console.error("ticket_events insert failed:", eventError);

    // --- notify subscribed technicians + send customer confirmation --------
    const internalSecret = Deno.env.get("INTERNAL_FN_SECRET");
    if (internalSecret) {
      try {
        await fetch(`${Deno.env.get("SUPABASE_URL")!.replace(".supabase.co", ".functions.supabase.co")}/notify-new-ticket`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-internal-secret": internalSecret },
          body: JSON.stringify({ ticket_id: ticket.id }),
        });
      } catch (err) {
        // Notification failure should never block the customer's ticket
        // submission from succeeding — just log it.
        console.error("notify-new-ticket call failed:", err);
      }
    } else {
      console.error("INTERNAL_FN_SECRET not set — skipping notify-new-ticket call.");
    }

    return jsonResponse({
      ticket_number: ticket.ticket_number,
      created_at: ticket.created_at,
      message: "Ticket submitted. Please keep your ticket number for reference.",
    });
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: "Unexpected error." }, 500);
  }
});
