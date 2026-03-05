import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: { user }, error: userErr } = await supabaseUser.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify admin role
    const { data: roleRow } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "admin")
      .single();

    if (!roleRow) {
      return new Response(JSON.stringify({ error: "Admin access required" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const url = new URL(req.url);
    const action = url.searchParams.get("action") || "list";

    if (action === "list") {
      // List all disputes with full details
      const { data: disputes, error } = await supabaseAdmin
        .from("disputes")
        .select(`
          *,
          transactions (
            id, title, amount, fee, total, status, category,
            buyer_id, seller_id, broker_id, created_by,
            buyer_email, seller_email, buyer_phone, seller_phone,
            counterparty_email, counterparty_phone
          )
        `)
        .order("created_at", { ascending: false });

      if (error) throw error;

      // Enrich with user profiles and phone numbers
      const enriched = [];
      for (const d of disputes || []) {
        const tx = (d as any).transactions;
        const participantIds = [tx?.buyer_id, tx?.seller_id, tx?.broker_id, tx?.created_by].filter(Boolean);
        const { data: profiles } = await supabaseAdmin
          .from("profiles")
          .select("user_id, first_name, last_name, email, phone")
          .in("user_id", participantIds);

        const profileMap: Record<string, any> = {};
        (profiles || []).forEach(p => profileMap[p.user_id] = p);

        enriched.push({
          ...d,
          participants: {
            buyer: tx?.buyer_id ? profileMap[tx.buyer_id] : null,
            seller: tx?.seller_id ? profileMap[tx.seller_id] : null,
            broker: tx?.broker_id ? profileMap[tx.broker_id] : null,
            creator: tx?.created_by ? profileMap[tx.created_by] : null,
          },
        });
      }

      return new Response(JSON.stringify({ disputes: enriched }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "resolve") {
      const { dispute_id, admin_notes, new_status } = await req.json();
      if (!dispute_id || !new_status) {
        return new Response(JSON.stringify({ error: "dispute_id and new_status required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { error } = await supabaseAdmin
        .from("disputes")
        .update({
          status: new_status,
          admin_notes: admin_notes || null,
          resolved_by: user.id,
          resolved_at: new Date().toISOString(),
        })
        .eq("id", dispute_id);

      if (error) throw error;

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown action" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
