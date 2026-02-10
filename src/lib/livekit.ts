import { getServerUrl, getToken } from "./api";

const LIVEKIT_URL = import.meta.env.VITE_LIVEKIT_URL || "";

export function getLiveKitUrl(): string {
  return LIVEKIT_URL;
}

export async function fetchLiveKitToken(params: {
  room: string;
  userId: string;
  username: string;
}): Promise<string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const token = getToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${getServerUrl()}/api/livekit/token`, {
    method: "POST",
    headers,
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || "Failed to fetch LiveKit token");
  }

  const data = (await res.json()) as { token?: string };
  if (!data.token) {
    throw new Error("Token missing from response");
  }
  return data.token;
}
