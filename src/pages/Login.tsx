import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { setLiveKitUrl } from "../lib/livekit";

interface ServerInfo {
  name: string;
  registrationOpen: boolean;
  inviteOnly: boolean;
  livekitUrl?: string;
}

export default function Login() {
  const navigate = useNavigate();
  const {
    token,
    loading,
    signInWithPassword,
    signUp,
    serverUrl,
    setServerUrl,
  } = useAuth();

  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [localServerUrl, setLocalServerUrl] = useState(serverUrl);
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [fetchingInfo, setFetchingInfo] = useState(false);

  useEffect(() => {
    if (token) {
      navigate("/");
    }
  }, [token, navigate]);

  // Fetch server info when server URL changes
  const fetchServerInfo = useCallback(async (url: string) => {
    if (!url) return;
    setFetchingInfo(true);
    try {
      const res = await fetch(`${url}/api/server/info`);
      if (res.ok) {
        const data = await res.json();
        setServerInfo(data);
        // Persist LiveKit URL so voice/video connects to the right server
        if (data.livekitUrl) {
          setLiveKitUrl(data.livekitUrl);
        }
      } else {
        setServerInfo(null);
      }
    } catch {
      setServerInfo(null);
    }
    setFetchingInfo(false);
  }, []);

  // Fetch on mount if we already have a server URL
  useEffect(() => {
    if (serverUrl) {
      fetchServerInfo(serverUrl);
    }
  }, [serverUrl, fetchServerInfo]);

  function handleServerUrlBlur() {
    const trimmedUrl = localServerUrl.trim().replace(/\/+$/, "");
    if (trimmedUrl && trimmedUrl !== serverUrl) {
      setServerUrl(trimmedUrl);
      fetchServerInfo(trimmedUrl);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    // Apply server URL if changed
    const trimmedUrl = localServerUrl.trim().replace(/\/+$/, "");
    if (!trimmedUrl) {
      setError("Server address is required");
      return;
    }
    if (trimmedUrl !== serverUrl) {
      setServerUrl(trimmedUrl);
    }

    setSubmitting(true);

    let result;
    if (mode === "login") {
      result = await signInWithPassword(email, password);
    } else {
      if (!username.trim()) {
        setError("Username is required");
        setSubmitting(false);
        return;
      }
      result = await signUp(
        email,
        password,
        username.trim(),
        inviteCode || undefined,
      );
    }

    if (result.error) {
      setError(result.error);
    }
    setSubmitting(false);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center flex-1 bg-(--bg-primary)">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-(--accent) border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-(--text-muted)">Loading...</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="relative flex items-center justify-center flex-1 overflow-hidden"
      style={{
        background:
          "radial-gradient(ellipse at 50% 0%, #1a1a3a 0%, var(--bg-primary) 70%)",
      }}
    >
      {/* Animated background orbs */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div
          className="animate-float absolute -top-24 -left-24 w-125 h-125 rounded-full opacity-30"
          style={{
            background:
              "radial-gradient(circle, rgba(124,106,255,0.12) 0%, transparent 70%)",
          }}
        />
        <div
          className="animate-float-delayed absolute -bottom-32 -right-32 w-150 h-150 rounded-full opacity-25"
          style={{
            background:
              "radial-gradient(circle, rgba(99,102,241,0.1) 0%, transparent 70%)",
          }}
        />
        <div
          className="animate-float-slow absolute top-1/3 left-2/3 w-75 h-75 rounded-full opacity-20"
          style={{
            background:
              "radial-gradient(circle, rgba(139,92,246,0.15) 0%, transparent 70%)",
          }}
        />
        {/* Grid overlay */}
        <div
          className="absolute inset-0 opacity-[0.03]"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)",
            backgroundSize: "60px 60px",
          }}
        />
      </div>

      <div className="relative z-10 w-full max-w-105 mx-4 animate-fade-up">
        {/* Logo & branding */}
        <div className="text-center mb-10">
          <div
            className="inline-flex items-center justify-center w-14 h-14 mb-5 rounded-2xl"
            style={{
              background:
                "linear-gradient(135deg, rgba(124,106,255,0.2) 0%, rgba(139,92,246,0.1) 100%)",
              border: "1px solid rgba(124,106,255,0.15)",
              boxShadow: "0 0 40px rgba(124,106,255,0.1)",
            }}
          >
            <svg
              className="w-7 h-7"
              fill="none"
              viewBox="0 0 24 24"
              stroke="url(#icon-gradient)"
              strokeWidth={1.5}
            >
              <defs>
                <linearGradient
                  id="icon-gradient"
                  x1="0%"
                  y1="0%"
                  x2="100%"
                  y2="100%"
                >
                  <stop offset="0%" stopColor="#a78bfa" />
                  <stop offset="100%" stopColor="#7c6aff" />
                </linearGradient>
              </defs>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242m9.345-8.334a2.126 2.126 0 00-.476-.095 48.64 48.64 0 00-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0011.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155"
              />
            </svg>
          </div>
          <h1 className="text-[28px] font-bold text-white tracking-tight">
            {mode === "login" ? "Welcome back" : "Create an account"}
          </h1>
          <p className="mt-1.5 text-sm text-(--text-muted)">
            {mode === "login"
              ? "Sign in to continue to ChitChat"
              : "Get started with ChitChat"}
          </p>
        </div>

        {/* Card */}
        <div
          className="rounded-2xl"
          style={{
            padding: 28,
            background:
              "linear-gradient(180deg, rgba(22,22,34,0.9) 0%, rgba(15,15,23,0.95) 100%)",
            border: "1px solid var(--border)",
            boxShadow:
              "0 25px 60px -12px rgba(0,0,0,0.5), 0 0 1px rgba(255,255,255,0.05) inset",
          }}
        >
          {error && (
            <div
              className="rounded-lg"
              style={{
                marginBottom: 20,
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                padding: "12px 14px",
                fontSize: 13,
                background: "rgba(248,113,113,0.08)",
                border: "1px solid rgba(248,113,113,0.15)",
                color: "var(--danger)",
              }}
            >
              <svg
                className="w-4 h-4 shrink-0 mt-0.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
                />
              </svg>
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit}>
            <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
              {/* Server address */}
              <div>
                <label className="block mb-1.5 text-[12px] font-medium text-(--text-secondary)">
                  Server Address
                </label>
                <input
                  type="text"
                  value={localServerUrl}
                  onChange={(e) => setLocalServerUrl(e.target.value)}
                  onBlur={handleServerUrlBlur}
                  placeholder="http://localhost:3001"
                  className="login-input"
                />
                {fetchingInfo && (
                  <p className="mt-1 text-[11px] text-(--text-muted)">
                    Connecting...
                  </p>
                )}
                {serverInfo && !fetchingInfo && (
                  <p className="mt-1 text-[11px] text-(--accent)">
                    {serverInfo.name}
                  </p>
                )}
              </div>

              {mode === "register" && (
                <>
                  <div>
                    <label className="block mb-1.5 text-[12px] font-medium text-(--text-secondary)">
                      Username
                    </label>
                    <input
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="How others will see you"
                      className="login-input"
                    />
                  </div>
                  {serverInfo?.inviteOnly && (
                    <div>
                      <label className="block mb-1.5 text-[12px] font-medium text-(--text-secondary)">
                        Invite Code
                      </label>
                      <input
                        type="text"
                        value={inviteCode}
                        onChange={(e) => setInviteCode(e.target.value)}
                        placeholder="Enter invite code"
                        className="login-input"
                      />
                    </div>
                  )}
                </>
              )}

              <div>
                <label className="block mb-1.5 text-[12px] font-medium text-(--text-secondary)">
                  Email
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="login-input"
                />
              </div>

              <div>
                <label className="block mb-1.5 text-[12px] font-medium text-(--text-secondary)">
                  Password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  className="login-input"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting || !email || !password}
              className="w-full h-11 rounded-lg text-[14px] font-semibold text-white cursor-pointer transition-all duration-200 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100"
              style={{
                marginTop: 24,
                background: submitting
                  ? "var(--accent-hover)"
                  : "linear-gradient(135deg, #7c6aff 0%, #6b5ce7 100%)",
                boxShadow:
                  "0 4px 16px rgba(124,106,255,0.25), 0 0 0 1px rgba(124,106,255,0.15) inset",
              }}
              onMouseEnter={(e) => {
                if (!submitting) {
                  e.currentTarget.style.boxShadow =
                    "0 4px 24px rgba(124,106,255,0.35), 0 0 0 1px rgba(124,106,255,0.2) inset";
                  e.currentTarget.style.transform = "translateY(-1px)";
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.boxShadow =
                  "0 4px 16px rgba(124,106,255,0.25), 0 0 0 1px rgba(124,106,255,0.15) inset";
                e.currentTarget.style.transform = "translateY(0)";
              }}
            >
              {submitting ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Please wait...
                </span>
              ) : mode === "login" ? (
                "Sign In"
              ) : (
                "Create Account"
              )}
            </button>
          </form>

          {/* Toggle login/register */}
          <p
            style={{
              marginTop: 24,
              textAlign: "center",
              fontSize: 13,
              color: "var(--text-muted)",
            }}
          >
            {mode === "login" ? (
              serverInfo?.registrationOpen !== false ? (
                <>
                  Don't have an account?{" "}
                  <button
                    type="button"
                    onClick={() => {
                      setMode("register");
                      setError("");
                    }}
                    className="text-(--accent) font-medium hover:text-white cursor-pointer transition-colors"
                  >
                    Sign up
                  </button>
                </>
              ) : (
                <span>Registration is closed on this server</span>
              )
            ) : (
              <>
                Already have an account?{" "}
                <button
                  type="button"
                  onClick={() => {
                    setMode("login");
                    setError("");
                  }}
                  className="text-(--accent) font-medium hover:text-white cursor-pointer transition-colors"
                >
                  Sign in
                </button>
              </>
            )}
          </p>
        </div>

        {/* Footer */}
        <p className="mt-8 text-center text-[11px] tracking-wide text-(--text-muted) opacity-50">
          Self-hosted chat &middot; Your data, your server
        </p>
      </div>
    </div>
  );
}
