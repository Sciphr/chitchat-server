import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import { getConfig } from "../config.js";

export interface JwtPayload {
  userId: string;
  username: string;
  email: string;
  isAdmin: boolean;
  purpose?: "auth" | "two_factor_challenge";
}

export function generateToken(payload: JwtPayload): string {
  const config = getConfig();
  return jwt.sign(payload, config.jwtSecret, {
    expiresIn: `${config.jwtExpiryDays}d`,
  });
}

export function generateTwoFactorChallengeToken(payload: JwtPayload): string {
  const config = getConfig();
  return jwt.sign(
    { ...payload, purpose: "two_factor_challenge" },
    config.jwtSecret,
    { expiresIn: "5m" }
  );
}

export function verifyToken(token: string): JwtPayload {
  const config = getConfig();
  return jwt.verify(token, config.jwtSecret) as JwtPayload;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing authorization token" });
    return;
  }
  try {
    const payload = verifyToken(header.slice(7));
    (req as any).user = payload;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const user = (req as any).user as JwtPayload | undefined;
  if (!user || !user.isAdmin) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}
