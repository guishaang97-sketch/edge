// POST /create-machine
// Header: Authorization: Bearer <technician's Supabase session token>
// Body: {
//   customer_name, brand, machine_model, serial_number, region,  // required
//   contract_type,       // optional: parts/service/parts_and_service/rtu
//   contract_validity,   // optional: "YYYY-MM-DD"
//   install_date         // optional: "YYYY-MM-DD"
// }
//
// Staff-only, enforced two ways: (1) deployed WITHOUT --no-verify-jwt, so
// Supabase's gateway rejects requests with no valid session token before
// this code even runs; (2) the code below additionally checks the caller
// is an active dispatcher or admin — a valid login alone isn't enough,
// since a plain technician account shouldn't be creating machine records.
//
// De-duplication behavior (keyed on serial_number, which is unique in the
// DB): if a machine with this serial already exists —
//   - identical fields  -> no write, just returns the existing qr_short_id
//   - any field changed -> updates that row in place, SAME qr_short_id
//                          (no duplicate row, no new QR code printed)
// Only a genuinely new serial number creates a new row + new qr_short_id.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, handleOptions, jsonResponse } from "../_shared/cors.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

async function requireDispatcherOrAdmin(req: Request): Promise<{ ok: true; userId: string } | { ok: false; res: Response }> {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return { ok: false, res: jsonResponse({ error: "Missing Authorization header." }, 401) };

  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData.user) {
    return { ok: false, res: jsonResponse({ error: "Invalid or expired session." }, 401) };
  }

  const { data: tech, error: techError } = await supabase
    .from("technicians")
    .select("role, active")
    .eq("id", userData.user.id)
    .maybeSingle();

  if (techError || !tech || !tech.active || !["dispatcher", "admin"].includes(tech.role)) {
    return { ok: false, res: jsonResponse({ error: "Only active dispatchers/admins can do this." }, 403) };
  }

  return { ok: true, userId: userData.user.id };
}

const VALID_REGIONS = ["NCR", "North", "South", "Cebu", "Davao", "NSC"];
const VALID_TYPES = ["parts", "service", "parts_and_service", "rtu"];

interface MachinePayload {
  customer_name?: string;
  brand?: string;
  machine_model?: string;
  serial_number?: string;
  region?: string;
  contract_type?: string | null;
  contract_validity?: string | null;
  install_date?: string | null;
}

function generateShortId(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

Deno.serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return jsonResponse({ error: "Use POST." }, 405);
  }

  const auth = await requireDispatcherOrAdmin(req);
  if (!auth.ok) return auth.res;

  try {
    const payload: MachinePayload = await req.json();
    const {
      customer_name,
      brand,
      machine_model,
      serial_number,
      region,
      contract_type,
      contract_validity,
      install_date,
    } = payload;

    // --- validation: only contract_type + contract_validity are optional ---
    const missing: string[] = [];
    if (!customer_name) missing.push("customer_name");
    if (!brand) missing.push("brand");
    if (!machine_model) missing.push("machine_model");
    if (!serial_number) missing.push("serial_number");
    if (!region) missing.push("region");
    if (missing.length > 0) {
      return jsonResponse({ error: `Missing required field(s): ${missing.join(", ")}` }, 400);
    }
    if (!VALID_REGIONS.includes(region!)) {
      return jsonResponse({ error: `region must be one of: ${VALID_REGIONS.join(", ")}` }, 400);
    }
    if (contract_type && !VALID_TYPES.includes(contract_type)) {
      return jsonResponse({ error: `contract_type must be one of: ${VALID_TYPES.join(", ")}` }, 400);
    }

    const normalized = {
      customer_name: customer_name!,
      brand: brand!,
      machine_model: machine_model!,
      serial_number: serial_number!,
      region: region!,
      contract_type: contract_type || null,
      contract_validity: contract_validity || null,
      install_date: install_date || null,
    };

    // --- look up by serial_number first (dedup key) -------------------------
    // Only active machines count as a match — a retired machine's serial
    // number is deliberately free to reuse when it's re-registered under a
    // new customer (see retire-machine).
    const { data: existing, error: lookupError } = await supabase
      .from("machines")
      .select("*")
      .eq("serial_number", normalized.serial_number)
      .eq("active", true)
      .maybeSingle();

    if (lookupError) {
      console.error(lookupError);
      return jsonResponse({ error: "Lookup failed." }, 500);
    }

    if (existing) {
      const unchanged =
        existing.customer_name === normalized.customer_name &&
        existing.brand === normalized.brand &&
        existing.machine_model === normalized.machine_model &&
        existing.region === normalized.region &&
        (existing.contract_type ?? null) === normalized.contract_type &&
        (existing.contract_validity ?? null) === normalized.contract_validity;

      if (unchanged) {
        return jsonResponse({
          machine_id: existing.id,
          qr_short_id: existing.qr_short_id,
          status: "unchanged",
        });
      }

      const { data: updated, error: updateError } = await supabase
        .from("machines")
        .update({
          customer_name: normalized.customer_name,
          brand: normalized.brand,
          machine_model: normalized.machine_model,
          region: normalized.region,
          contract_type: normalized.contract_type,
          contract_validity: normalized.contract_validity,
          install_date: normalized.install_date,
        })
        .eq("id", existing.id)
        .select("id, qr_short_id")
        .single();

      if (updateError) {
        console.error(updateError);
        return jsonResponse({ error: updateError.message }, 400);
      }

      return jsonResponse({
        machine_id: updated.id,
        qr_short_id: updated.qr_short_id,
        status: "updated",
      });
    }

    // --- genuinely new machine: generate id, retry on rare collision -------
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const qr_short_id = generateShortId();
      const { data, error } = await supabase
        .from("machines")
        .insert({ ...normalized, qr_short_id })
        .select("id, qr_short_id")
        .single();

      if (!error) {
        return jsonResponse({ machine_id: data.id, qr_short_id: data.qr_short_id, status: "created" });
      }

      if (error.code !== "23505" || !error.message.includes("qr_short_id")) {
        console.error(error);
        return jsonResponse({ error: error.message }, 400);
      }
      lastError = error;
    }

    console.error("Exhausted retries generating a unique qr_short_id", lastError);
    return jsonResponse({ error: "Could not generate a unique QR code, please try again." }, 500);
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: "Unexpected error." }, 500);
  }
});
