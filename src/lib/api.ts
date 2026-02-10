let serverUrl =
  localStorage.getItem("chitchat_server_url") ||
  (import.meta.env.VITE_SERVER_URL as string) ||
  "http://localhost:3001";

let authToken: string | null = localStorage.getItem("chitchat_token");

export function getServerUrl(): string {
  return serverUrl;
}

export function setServerUrl(url: string) {
  serverUrl = url.replace(/\/+$/, "");
  localStorage.setItem("chitchat_server_url", serverUrl);
}

export function getToken(): string | null {
  return authToken;
}

export function setToken(token: string | null) {
  authToken = token;
  if (token) {
    localStorage.setItem("chitchat_token", token);
  } else {
    localStorage.removeItem("chitchat_token");
  }
}

export async function apiFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) || {}),
  };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  return fetch(`${serverUrl}${path}`, { ...options, headers });
}
