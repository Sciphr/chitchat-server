const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3001";
const LIVEKIT_URL = import.meta.env.VITE_LIVEKIT_URL || "";

export function getLiveKitUrl(): string {
  return LIVEKIT_URL;
}

export async function fetchLiveKitToken(params: {
  room: string;
  userId: string;
  username: string;
}): Promise<string> {
  const res = await fetch(`${SERVER_URL}/api/livekit/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
