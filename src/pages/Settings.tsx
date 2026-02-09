import { useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";

export default function Settings() {
  const navigate = useNavigate();
  const { user, username, signOut } = useAuth();

  async function handleLogout() {
    await signOut();
    navigate("/login");
  }

  return (
    <div className="flex items-center justify-center h-screen bg-[var(--bg-primary)]">
      <div className="w-full max-w-md p-8 bg-[var(--bg-secondary)] rounded-xl border border-[var(--border)]">
        <h1 className="text-xl font-bold mb-6">Settings</h1>

        <div className="space-y-4">
          <div>
            <label className="block text-sm text-[var(--text-muted)] mb-1">
              Username
            </label>
            <p className="text-[var(--text-primary)]">{username}</p>
          </div>

          <div>
            <label className="block text-sm text-[var(--text-muted)] mb-1">
              Email
            </label>
            <p className="text-[var(--text-primary)]">{user?.email || "—"}</p>
          </div>

          <div>
            <label className="block text-sm text-[var(--text-muted)] mb-1">
              User ID
            </label>
            <p className="text-xs text-[var(--text-secondary)] font-mono">
              {user?.id || "—"}
            </p>
          </div>
        </div>

        <div className="flex gap-3 mt-8">
          <button
            onClick={() => navigate("/")}
            className="flex-1 py-2 bg-[var(--bg-tertiary)] text-white rounded-lg hover:bg-[var(--accent)] cursor-pointer transition-colors"
          >
            Back
          </button>
          <button
            onClick={handleLogout}
            className="flex-1 py-2 bg-[var(--danger)] text-white rounded-lg hover:opacity-80 cursor-pointer transition-colors"
          >
            Sign Out
          </button>
        </div>
      </div>
    </div>
  );
}
