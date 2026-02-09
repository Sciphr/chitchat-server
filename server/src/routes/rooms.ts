import { Router } from "express";
import { getSupabase } from "../db/supabase.js";

const router = Router();

// GET /api/rooms
router.get("/", async (_req, res) => {
  const supabase = getSupabase();
  if (!supabase) {
    res.status(503).json({ error: "Supabase not configured on this server" });
    return;
  }

  const { data, error } = await supabase
    .from("rooms")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json(data);
});

// POST /api/rooms
router.post("/", async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) {
    res.status(503).json({ error: "Supabase not configured on this server" });
    return;
  }

  const { name, type, created_by } = req.body;

  if (!name || !type) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  const { data, error } = await supabase
    .from("rooms")
    .insert({ name, type, created_by: created_by || "system" })
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json(data);
});

export default router;
