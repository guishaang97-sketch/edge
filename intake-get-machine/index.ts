// GET /intake-get-machine?qr=<qr_short_id>
//
// Public, unauthenticated. Called when a customer scans the QR code on a
// machine, before they see the intake form — lets the form show "Customer
// Name / Brand / Machine / Serial / Type / Validity" read-only, pulled from
// the machine record created when the label was generated, so the customer
// only has to type the issue description + their contact info.
//
// Uses the service role key server-side (never exposed to the browser) so
// this can run without the customer being an authenticated staff member.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, handleOptions, jsonResponse } from "../_shared/cors.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  try {
    const url = new URL(req.url);
    const qr = url.searchParams.get("qr");

    if (!qr) {
      return jsonResponse({ error: "Missing 'qr' query parameter." }, 400);
    }

    const { data, error } = await supabase
      .from("machines")
      .select(
        "id, qr_short_id, customer_name, brand, machine_model, serial_number, contract_type, contract_validity, region",
      )
      .eq("qr_short_id", qr)
      .eq("active", true)
      .maybeSingle();

    if (error) {
      console.error(error);
      return jsonResponse({ error: "Lookup failed." }, 500);
    }

    if (!data) {
      // Unknown QR code OR a retired one — same generic message either
      // way, so a retired sticker doesn't leak which machine/customer it
      // used to belong to. Frontend should show a friendly "machine not
      // found, please contact support" message rather than a raw error.
      return jsonResponse({ error: "Machine not found for this QR code." }, 404);
    }

    return jsonResponse({ machine: data });
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: "Unexpected error." }, 500);
  }
});
