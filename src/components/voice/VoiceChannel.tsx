import type { Room } from "../../types";

interface VoiceChannelProps {
  room: Room;
}

export default function VoiceChannel({ room }: VoiceChannelProps) {
  return (
    <div className="flex flex-col h-full">
      {/* Room header */}
      <div className="flex items-center px-4 py-3 border-b border-[var(--border)] bg-[var(--bg-secondary)]">
        <span className="text-[var(--text-muted)] mr-2">🔊</span>
        <h2 className="text-base font-semibold">{room.name}</h2>
      </div>

      {/* Voice UI placeholder */}
      <div className="flex-1 flex flex-col items-center justify-center gap-6">
        <div className="w-24 h-24 rounded-full bg-[var(--bg-tertiary)] flex items-center justify-center">
          <span className="text-4xl">🎙️</span>
        </div>

        <div className="text-center">
          <h3 className="text-lg font-semibold mb-2">Voice Channel</h3>
          <p className="text-sm text-[var(--text-muted)] max-w-xs">
            Voice and video calling will be powered by LiveKit. This feature is
            coming soon.
          </p>
        </div>

        <div className="flex gap-3">
          <button
            disabled
            className="px-6 py-2 bg-[var(--success)] text-white rounded-lg opacity-50 cursor-not-allowed"
          >
            Join Voice
          </button>
          <button
            disabled
            className="px-6 py-2 bg-[var(--bg-tertiary)] text-white rounded-lg opacity-50 cursor-not-allowed"
          >
            Start Video
          </button>
        </div>
      </div>
    </div>
  );
}
