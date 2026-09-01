// POST /create-technician
// Header: Authorization: Bearer <admin's Supabase session token>
// Body: {
//   email, password, name,               // required
//   role,                                 // "technician" | "dispatcher" | "admin" | "viewer"
//   regions_subscribed,                   // string[] of regions, optional (default [])
//   default_region,                       // string or null, optional
//   phone                                 // optional
// }
//
// Admin-only. The dashboard's anon key can't create Supabase Auth users
// directly (that needs the service role's admin API), so this function
// does both steps atomically: create the auth user, then the matching
// technicians row. If the second step fails, the created auth user is
// rolled back (deleted) so you don't end up with an orphaned login that
// has no technician profile.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, handleOptions, jsonResponse } from "../_shared/cors.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const VALID_ROLES = ["technician", "dispatcher", "admin", "viewer"];
const VALID_REGIONS = ["NCR", "North", "South", "Cebu", "Davao", "NSC"];

async function requireAdmin(req: Request): Promise<{ ok: true } | { ok: false; res: Response }> {
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

  if (techError || !tech || !tech.active || tech.role !== "admin") {
    return { ok: false, res: jsonResponse({ error: "Admin only." }, 403) };
  }

  return { ok: true };
}

interface CreatePayload {
  email?: string;
  password?: string;
  name?: string;
  role?: string;
  regions_subscribed?: string[];
  default_region?: string | null;
  phone?: string | null;
}

Deno.serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") return jsonResponse({ error: "Use POST." }, 405);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.res;

  try {
    const payload: CreatePayload = await req.json();
    const { email, password, name, role, regions_subscribed, default_region, phone } = payload;

    const missing: string[] = [];
    if (!email) missing.push("email");
    if (!password) missing.push("password");
    if (!name) missing.push("name");
    if (!role) missing.push("role");
    if (missing.length > 0) {
      return jsonResponse({ error: `Missing required field(s): ${missing.join(", ")}` }, 400);
    }
    if (!VALID_ROLES.includes(role!)) {
      return jsonResponse({ error: `role must be one of: ${VALID_ROLES.join(", ")}` }, 400);
    }
    if (password!.length < 8) {
      return jsonResponse({ error: "Password must be at least 8 characters." }, 400);
    }
    const regions = (regions_subscribed || []).filter((r) => VALID_REGIONS.includes(r));
    if (default_region && !VALID_REGIONS.includes(default_region)) {
      return jsonResponse({ error: `default_region must be one of: ${VALID_REGIONS.join(", ")}` }, 400);
    }

    // --- 1. create the auth user --------------------------------------------
    const { data: created, error: createError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // skip email verification — this is an internal staff tool, not public signup
    });

    if (createError || !created.user) {
      return jsonResponse({ error: createError?.message || "Could not create the login." }, 400);
    }

    // --- 2. create the matching technicians row -----------------------------
    const { data: techRow, error: techInsertError } = await supabase
      .from("technicians")
      .insert({
        id: created.user.id,
        name,
        email,
        phone: phone || null,
        role,
        regions_subscribed: regions,
        default_region: default_region || null,
        active: true,
      })
      .select("*")
      .single();

    if (techInsertError) {
      // Roll back the orphaned auth user so a failed technician insert
      // doesn't leave a login with no profile behind it.
      await supabase.auth.admin.deleteUser(created.user.id);
      return jsonResponse({ error: techInsertError.message }, 400);
    }

    return jsonResponse({ technician: techRow });
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: "Unexpected error." }, 500);
  }
});
