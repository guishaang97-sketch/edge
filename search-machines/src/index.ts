// GET /search-machines?q=<term>
// Header: Authorization: Bearer <technician's Supabase session token>
//
// Powers the "recall past QR" search in the label generator. Matches
// against customer_name, serial_number, brand, and machine_model.
// Requires at least 2 characters to avoid scanning the whole table on
// every keystroke — keeps this cheap on Supabase's free tier.
//
// Staff-only, enforced two ways: deployed WITHOUT --no-verify-jwt (gateway
// rejects anonymous requests before this code runs), plus a role check
// below restricting it to active dispatchers/admins.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, handleOptions, jsonResponse } from "../_shared/cors.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

async function requireDispatcherOrAdmin(req: Request): Promise<{ ok: true } | { ok: false; res: Response }> {
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

  return { ok: true };
}

Deno.serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  const auth = await requireDispatcherOrAdmin(req);
  if (!auth.ok) return auth.res;

  try {
    const url = new URL(req.url);
    const q = (url.searchParams.get("q") || "").trim();

    if (q.length < 4) {
      return jsonResponse({ machines: [] });
    }

    const term = `%${q}%`;
    const { data, error } = await supabase
      .from("machines")
      .select(
        "id, qr_short_id, customer_name, brand, machine_model, serial_number, region, contract_type, contract_validity, active, retired_reason, created_at",
      )
      .or(
        `customer_name.ilike.${term},serial_number.ilike.${term},brand.ilike.${term},machine_model.ilike.${term}`,
      )
      .order("created_at", { ascending: false })
      .limit(15);

    if (error) {
      console.error(error);
      return jsonResponse({ error: "Search failed." }, 500);
    }

    return jsonResponse({ machines: data });
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: "Unexpected error." }, 500);
  }
});
