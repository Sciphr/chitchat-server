import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";

export default function Login() {
  const navigate = useNavigate();
  const { session, loading, signInWithPassword, signUp, signInWithGoogle } =
    useAuth();

  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (session) {
      navigate("/");
    }
  }, [session, navigate]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
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
      result = await signUp(email, password, username.trim());
    }

    if (result.error) {
      setError(result.error);
    }
    setSubmitting(false);
  }

  async function handleGoogle() {
    setError("");
    const result = await signInWithGoogle();
    if (result.error) {
      setError(result.error);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-[var(--bg-primary)]">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-[var(--text-muted)]">Loading...</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="relative flex items-center justify-center h-screen overflow-hidden"
      style={{
        background:
          "radial-gradient(ellipse at 50% 0%, #1a1a3a 0%, var(--bg-primary) 70%)",
      }}
    >
      {/* Animated background orbs */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div
          className="animate-float absolute -top-24 -left-24 w-[500px] h-[500px] rounded-full opacity-30"
          style={{
            background:
              "radial-gradient(circle, rgba(124,106,255,0.12) 0%, transparent 70%)",
          }}
        />
        <div
          className="animate-float-delayed absolute -bottom-32 -right-32 w-[600px] h-[600px] rounded-full opacity-25"
          style={{
            background:
              "radial-gradient(circle, rgba(99,102,241,0.1) 0%, transparent 70%)",
          }}
        />
        <div
          className="animate-float-slow absolute top-1/3 left-2/3 w-[300px] h-[300px] rounded-full opacity-20"
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

      <div className="relative z-10 w-full max-w-[420px] mx-4 animate-fade-up">
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
          <p className="mt-1.5 text-sm text-[var(--text-muted)]">
            {mode === "login"
              ? "Sign in to continue to ChitChat"
              : "Get started with ChitChat"}
          </p>
        </div>

        {/* Card */}
        <div
          className="rounded-2xl p-7"
          style={{
            background:
              "linear-gradient(180deg, rgba(22,22,34,0.9) 0%, rgba(15,15,23,0.95) 100%)",
            border: "1px solid var(--border)",
            boxShadow:
              "0 25px 60px -12px rgba(0,0,0,0.5), 0 0 1px rgba(255,255,255,0.05) inset",
          }}
        >
          {error && (
            <div
              className="mb-5 flex items-start gap-2.5 px-3.5 py-3 text-[13px] rounded-lg"
              style={{
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

          {/* Google button */}
          <button
            type="button"
            onClick={handleGoogle}
            className="group w-full flex items-center justify-center gap-3 h-11 mb-5 rounded-lg text-[14px] font-medium cursor-pointer transition-all duration-200 active:scale-[0.98]"
            style={{
              background: "rgba(255,255,255,0.05)",
              border: "1px solid var(--border-light)",
              color: "var(--text-primary)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(255,255,255,0.09)";
              e.currentTarget.style.borderColor = "rgba(255,255,255,0.12)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "rgba(255,255,255,0.05)";
              e.currentTarget.style.borderColor = "var(--border-light)";
            }}
          >
            <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24">
              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                fill="#4285F4"
              />
              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="#34A853"
              />
              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                fill="#FBBC05"
              />
              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                fill="#EA4335"
              />
            </svg>
            Continue with Google
          </button>

          {/* Divider */}
          <div className="flex items-center gap-4 mb-5">
            <div className="flex-1 h-px bg-[var(--border)]" />
            <span className="text-[11px] uppercase tracking-[0.1em] font-medium text-[var(--text-muted)]">
              or continue with email
            </span>
            <div className="flex-1 h-px bg-[var(--border)]" />
          </div>

          <form onSubmit={handleSubmit}>
            <div className="flex flex-col gap-6">
              {mode === "register" && (
                <div>
                  <label className="block mb-1.5 text-[12px] font-medium text-[var(--text-secondary)]">
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
              )}

              <div>
                <label className="block mb-1.5 text-[12px] font-medium text-[var(--text-secondary)]">
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
                <label className="block mb-1.5 text-[12px] font-medium text-[var(--text-secondary)]">
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
              className="w-full h-11 mt-6 rounded-lg text-[14px] font-semibold text-white cursor-pointer transition-all duration-200 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100"
              style={{
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
          <p className="mt-6 text-center text-[13px] text-[var(--text-muted)]">
            {mode === "login" ? (
              <>
                Don't have an account?{" "}
                <button
                  type="button"
                  onClick={() => {
                    setMode("register");
                    setError("");
                  }}
                  className="text-[var(--accent)] font-medium hover:text-white cursor-pointer transition-colors"
                >
                  Sign up
                </button>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <button
                  type="button"
                  onClick={() => {
                    setMode("login");
                    setError("");
                  }}
                  className="text-[var(--accent)] font-medium hover:text-white cursor-pointer transition-colors"
                >
                  Sign in
                </button>
              </>
            )}
          </p>
        </div>

        {/* Footer */}
        <p className="mt-8 text-center text-[11px] tracking-wide text-[var(--text-muted)] opacity-50">
          Self-hosted chat &middot; Your data, your server
        </p>
      </div>
    </div>
  );
}
