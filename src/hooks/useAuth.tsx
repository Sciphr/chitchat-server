import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  apiFetch,
  getToken,
  setToken,
  getServerUrl,
  setServerUrl as _setServerUrl,
} from "../lib/api";
import { resetSocket } from "../lib/socket";

interface UserInfo {
  id: string;
  email: string;
  isAdmin: boolean;
}

interface Profile {
  username: string;
  status: "online" | "offline" | "away" | "dnd";
  avatarUrl: string;
  about: string;
  pushToTalkEnabled: boolean;
  pushToTalkKey: string;
  audioInputId: string;
  audioOutputId: string;
  videoInputId: string;
}

interface AuthContext {
  token: string | null;
  user: UserInfo | null;
  username: string;
  profile: Profile;
  loading: boolean;
  serverUrl: string;
  setServerUrl: (url: string) => void;
  signInWithPassword: (
    email: string,
    password: string
  ) => Promise<{ error: string | null }>;
  signUp: (
    email: string,
    password: string,
    username: string,
    inviteCode?: string
  ) => Promise<{ error: string | null }>;
  updateProfile: (profile: Profile) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const DEFAULT_PROFILE: Profile = {
  username: "Anonymous",
  status: "online",
  avatarUrl: "",
  about: "",
  pushToTalkEnabled: false,
  pushToTalkKey: "Space",
  audioInputId: "",
  audioOutputId: "",
  videoInputId: "",
};

const AuthContext = createContext<AuthContext | null>(null);

function mapServerProfile(data: Record<string, any>): Profile {
  return {
    username: data.username || "Anonymous",
    status: (data.status as Profile["status"]) || "online",
    avatarUrl: data.avatar_url || "",
    about: data.about || "",
    pushToTalkEnabled: Boolean(data.push_to_talk_enabled),
    pushToTalkKey: data.push_to_talk_key || "Space",
    audioInputId: data.audio_input_id || "",
    audioOutputId: data.audio_output_id || "",
    videoInputId: data.video_input_id || "",
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(getToken());
  const [user, setUser] = useState<UserInfo | null>(null);
  const [profile, setProfile] = useState<Profile>(DEFAULT_PROFILE);
  const [loading, setLoading] = useState(true);
  const [serverUrl, setServerUrlState] = useState(getServerUrl());

  function handleSetServerUrl(url: string) {
    _setServerUrl(url);
    setServerUrlState(url);
    resetSocket();
  }

  // On mount, validate existing token
  useEffect(() => {
    const saved = getToken();
    if (!saved) {
      setLoading(false);
      return;
    }

    apiFetch("/api/auth/me")
      .then((res) => {
        if (!res.ok) throw new Error("Invalid token");
        return res.json();
      })
      .then((data) => {
        setUser({ id: data.id, email: data.email, isAdmin: data.isAdmin || false });
        setProfile(mapServerProfile(data));
        setTokenState(saved);
      })
      .catch(() => {
        setToken(null);
        setTokenState(null);
      })
      .finally(() => setLoading(false));
  }, []);

  async function signInWithPassword(email: string, password: string) {
    try {
      const res = await apiFetch("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();
      if (!res.ok) {
        return { error: data.error || "Login failed" };
      }

      setToken(data.token);
      setTokenState(data.token);
      setUser({ id: data.user.id, email: data.user.email, isAdmin: data.user.isAdmin || false });

      // Fetch full profile
      const profileRes = await apiFetch("/api/auth/me");
      if (profileRes.ok) {
        const profileData = await profileRes.json();
        setProfile(mapServerProfile(profileData));
      }

      return { error: null };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "Connection failed",
      };
    }
  }

  async function signUp(email: string, password: string, username: string, inviteCode?: string) {
    try {
      const res = await apiFetch("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({ email, password, username, inviteCode }),
      });

      const data = await res.json();
      if (!res.ok) {
        return { error: data.error || "Registration failed" };
      }

      setToken(data.token);
      setTokenState(data.token);
      setUser({ id: data.user.id, email: data.user.email, isAdmin: data.user.isAdmin || false });
      setProfile({
        ...DEFAULT_PROFILE,
        username: data.user.username || username,
      });

      return { error: null };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "Connection failed",
      };
    }
  }

  async function updateProfileFn(update: Profile) {
    if (!user) {
      return { error: "Not authenticated." };
    }

    try {
      const res = await apiFetch("/api/auth/profile", {
        method: "PUT",
        body: JSON.stringify({
          username: update.username.trim(),
          status: update.status,
          avatar_url: update.avatarUrl.trim(),
          about: update.about.trim(),
          push_to_talk_enabled: update.pushToTalkEnabled ? 1 : 0,
          push_to_talk_key: update.pushToTalkKey.trim() || "Space",
          audio_input_id: update.audioInputId || null,
          audio_output_id: update.audioOutputId || null,
          video_input_id: update.videoInputId || null,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        return { error: data.error || "Update failed" };
      }

      setProfile(mapServerProfile(data));
      return { error: null };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "Connection failed",
      };
    }
  }

  async function signOut() {
    setToken(null);
    setTokenState(null);
    setUser(null);
    setProfile(DEFAULT_PROFILE);
    resetSocket();
  }

  return (
    <AuthContext.Provider
      value={{
        token,
        user,
        username: profile.username,
        profile,
        loading,
        serverUrl,
        setServerUrl: handleSetServerUrl,
        signInWithPassword,
        signUp,
        updateProfile: updateProfileFn,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
