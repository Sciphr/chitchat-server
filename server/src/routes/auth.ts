import { Router } from "express";
import { getSupabase } from "../db/supabase.js";

const router = Router();

// POST /api/auth/register
router.post("/register", async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) {
    res.status(503).json({ error: "Supabase not configured on this server" });
    return;
  }

  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  // Create auth user via Supabase
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (authError) {
    res.status(400).json({ error: authError.message });
    return;
  }

  // Insert into users table
  const { error: dbError } = await supabase.from("users").insert({
    id: authData.user.id,
    username,
    email,
    status: "online",
  });

  if (dbError) {
    res.status(500).json({ error: dbError.message });
    return;
  }

  res.json({ user: { id: authData.user.id, username } });
});

// POST /api/auth/login
router.post("/login", async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) {
    res.status(503).json({ error: "Supabase not configured on this server" });
    return;
  }

  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    res.status(401).json({ error: error.message });
    return;
  }

  res.json({
    token: data.session.access_token,
    user: { id: data.user.id },
  });
});

export default router;
