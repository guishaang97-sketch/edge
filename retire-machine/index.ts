// POST /retire-machine
// Header: Authorization: Bearer <dispatcher/admin's Supabase session token>
// Body: { machine_id: string, reason: string }
//
// Marks a machine inactive instead of editing it in place. Use this
// specifically when a machine has moved to a different customer — editing
// customer_name in place would silently rewrite the customer shown on
// every past ticket for that machine, which is wrong. Retiring instead:
//   - the old QR becomes a dead end (intake-get-machine won't find it)
//   - all history for this machine stays exactly as it was
//   - the same serial number becomes free to register again under the
//     new customer (create-machine only dedup-matches active machines)
//
// Does NOT touch tickets or PM contracts tied to this machine — those stay
// as historical record. If there are active (non-terminated) PM contracts
// on this machine, they're flagged back in the response as a heads-up,
// but not auto-terminated — that's a separate, deliberate action.

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

Deno.serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") return jsonResponse({ error: "Use POST." }, 405);

  const auth = await requireDispatcherOrAdmin(req);
  if (!auth.ok) return auth.res;

  try {
    const { machine_id, reason } = await req.json();
    if (!machine_id) return jsonResponse({ error: "Missing machine_id." }, 400);
    if (!reason || reason.trim().length < 3) {
      return jsonResponse({ error: "A reason is required (at least a few words)." }, 400);
    }

    const { data: machine, error: fetchError } = await supabase
      .from("machines")
      .select("id, active")
      .eq("id", machine_id)
      .maybeSingle();

    if (fetchError || !machine) return jsonResponse({ error: "Machine not found." }, 404);
    if (!machine.active) return jsonResponse({ error: "This machine is already retired." }, 400);

    const { error: updateError } = await supabase
      .from("machines")
      .update({
        active: false,
        retired_at: new Date().toISOString(),
        retired_by: auth.userId,
        retired_reason: reason.trim(),
      })
      .eq("id", machine_id);

    if (updateError) return jsonResponse({ error: updateError.message }, 400);

    const { data: activeContracts } = await supabase
      .from("pm_contracts")
      .select("id, focus")
      .eq("machine_id", machine_id)
      .eq("status", "active");

    return jsonResponse({
      ok: true,
      active_pm_contracts_still_running: activeContracts || [],
    });
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: "Unexpected error." }, 500);
  }
});
