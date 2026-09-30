export function clampPlaybackPosition(value: number, duration: number): number {
  const position = Number.isFinite(value) ? Math.max(0, value) : 0;
  return Number.isFinite(duration) && duration > 0 ? Math.min(position, duration) : position;
}

// Only a known endpoint counts as finished; pausing near the end must still resume there.
export function isPlaybackAtEnd(position: number, duration: number): boolean {
  return Number.isFinite(position) && Number.isFinite(duration) && duration > 0 && position >= duration;
}

export function playbackLoadPosition(value: number, duration: number, autoplay: boolean) {
  const position = clampPlaybackPosition(value, duration);
  const completed = isPlaybackAtEnd(position, duration);
  return { position: completed && autoplay ? 0 : position, ended: completed && !autoplay };
}
