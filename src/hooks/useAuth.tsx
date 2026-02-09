import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";

interface AuthContext {
  session: Session | null;
  user: User | null;
  username: string;
  profile: {
    username: string;
    status: "online" | "offline" | "away" | "dnd";
    avatarUrl: string;
    about: string;
    pushToTalkEnabled: boolean;
    pushToTalkKey: string;
    audioInputId: string;
    audioOutputId: string;
    videoInputId: string;
  };
  loading: boolean;
  signInWithPassword: (
    email: string,
    password: string,
  ) => Promise<{ error: string | null }>;
  signUp: (
    email: string,
    password: string,
    username: string,
  ) => Promise<{ error: string | null }>;
  signInWithGoogle: () => Promise<{ error: string | null }>;
  updateProfile: (profile: {
    username: string;
    status: "online" | "offline" | "away" | "dnd";
    avatarUrl: string;
    about: string;
    pushToTalkEnabled: boolean;
    pushToTalkKey: string;
    audioInputId: string;
    audioOutputId: string;
    videoInputId: string;
  }) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContext | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState({
    username: "Anonymous",
    status: "online" as "online" | "offline" | "away" | "dnd",
    avatarUrl: "",
    about: "",
    pushToTalkEnabled: false,
    pushToTalkKey: "Space",
    audioInputId: "",
    audioOutputId: "",
    videoInputId: "",
  });

  useEffect(() => {
    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });

    // Listen for auth changes (handles OAuth redirects too)
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  const user = session?.user ?? null;

  function fallbackProfile(targetUser: User | null) {
    const fallbackUsername =
      targetUser?.user_metadata?.username ||
      targetUser?.user_metadata?.full_name ||
      targetUser?.email?.split("@")[0] ||
      "Anonymous";

    return {
      username: fallbackUsername,
      status: (targetUser?.user_metadata?.status as
        | "online"
        | "offline"
        | "away"
        | "dnd") ?? "online",
      avatarUrl: (targetUser?.user_metadata?.avatar_url as string) ?? "",
      about: (targetUser?.user_metadata?.about as string) ?? "",
      pushToTalkEnabled:
        (targetUser?.user_metadata?.push_to_talk_enabled as boolean) ?? false,
      pushToTalkKey:
        (targetUser?.user_metadata?.push_to_talk_key as string) ?? "Space",
      audioInputId:
        (targetUser?.user_metadata?.audio_input_id as string) ?? "",
      audioOutputId:
        (targetUser?.user_metadata?.audio_output_id as string) ?? "",
      videoInputId:
        (targetUser?.user_metadata?.video_input_id as string) ?? "",
    };
  }

  const username = profile.username;

  useEffect(() => {
    let cancelled = false;

    async function syncProfile() {
      if (!user) {
        setProfile(fallbackProfile(null));
        return;
      }

      const fallback = fallbackProfile(user);
      setProfile(fallback);

      const { data, error } = await supabase
        .from("users")
        .select(
          "username, status, avatar_url, about, push_to_talk_enabled, push_to_talk_key, audio_input_id, audio_output_id, video_input_id",
        )
        .eq("id", user.id)
        .maybeSingle();

      if (cancelled) return;

      if (error) {
        return;
      }

      if (!data) {
        await supabase.from("users").upsert(
          {
            id: user.id,
            email: user.email,
            username: fallback.username,
            status: fallback.status,
            avatar_url: fallback.avatarUrl || null,
            about: fallback.about || null,
            push_to_talk_enabled: fallback.pushToTalkEnabled,
            push_to_talk_key: fallback.pushToTalkKey,
            audio_input_id: fallback.audioInputId || null,
            audio_output_id: fallback.audioOutputId || null,
            video_input_id: fallback.videoInputId || null,
          },
          { onConflict: "id" },
        );
        if (!cancelled) {
          setProfile(fallback);
        }
        return;
      }

      setProfile({
        username: data.username || fallback.username,
        status: (data.status as "online" | "offline" | "away" | "dnd") || "online",
        avatarUrl: data.avatar_url || "",
        about: data.about || "",
        pushToTalkEnabled: data.push_to_talk_enabled ?? false,
        pushToTalkKey: data.push_to_talk_key || "Space",
        audioInputId: data.audio_input_id || "",
        audioOutputId: data.audio_output_id || "",
        videoInputId: data.video_input_id || "",
      });
    }

    syncProfile();

    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  async function signInWithPassword(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    return { error: error?.message ?? null };
  }

  async function signUp(email: string, password: string, username: string) {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { username },
      },
    });
    if (!error && data.user) {
      await supabase.from("users").upsert(
        {
          id: data.user.id,
          email,
          username,
          status: "online",
          push_to_talk_enabled: false,
          push_to_talk_key: "Space",
          audio_input_id: null,
          audio_output_id: null,
          video_input_id: null,
        },
        { onConflict: "id" },
      );
    }
    return { error: error?.message ?? null };
  }

  async function signInWithGoogle() {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: window.location.origin,
      },
    });
    return { error: error?.message ?? null };
  }

  async function updateProfile(update: {
    username: string;
    status: "online" | "offline" | "away" | "dnd";
    avatarUrl: string;
    about: string;
    pushToTalkEnabled: boolean;
    pushToTalkKey: string;
    audioInputId: string;
    audioOutputId: string;
    videoInputId: string;
  }) {
    if (!user) {
      return { error: "Not authenticated." };
    }

    const payload = {
      username: update.username.trim(),
      status: update.status,
      avatar_url: update.avatarUrl.trim(),
      about: update.about.trim(),
      push_to_talk_enabled: update.pushToTalkEnabled,
      push_to_talk_key: update.pushToTalkKey.trim() || "Space",
      audio_input_id: update.audioInputId || null,
      audio_output_id: update.audioOutputId || null,
      video_input_id: update.videoInputId || null,
      updated_at: new Date().toISOString(),
    };

    const { error: dbError } = await supabase.from("users").upsert(
      {
        id: user.id,
        email: user.email,
        ...payload,
      },
      { onConflict: "id" },
    );

    if (dbError) {
      return { error: dbError.message };
    }

    await supabase.auth.updateUser({
      data: {
        username: payload.username,
        status: payload.status,
        avatar_url: payload.avatar_url,
        about: payload.about,
        push_to_talk_enabled: payload.push_to_talk_enabled,
        push_to_talk_key: payload.push_to_talk_key,
        audio_input_id: payload.audio_input_id,
        audio_output_id: payload.audio_output_id,
        video_input_id: payload.video_input_id,
      },
    });

    setProfile({
      username: payload.username,
      status: payload.status,
      avatarUrl: payload.avatar_url,
      about: payload.about,
      pushToTalkEnabled: payload.push_to_talk_enabled,
      pushToTalkKey: payload.push_to_talk_key,
      audioInputId: payload.audio_input_id || "",
      audioOutputId: payload.audio_output_id || "",
      videoInputId: payload.video_input_id || "",
    });

    return { error: null };
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  return (
    <AuthContext.Provider
      value={{
        session,
        user,
        username,
        profile,
        loading,
        signInWithPassword,
        signUp,
        signInWithGoogle,
        updateProfile,
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
