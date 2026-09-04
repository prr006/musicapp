/**
 * Audio pipeline capabilities, stated explicitly instead of faked.
 *
 * MELO plays provider streams through ONE HTMLAudioElement inside
 * Wails/WebView2. Three "pro" player features were investigated for this
 * pipeline; each verdict below is deliberate and test-asserted so no UI ever
 * advertises something the pipeline cannot honestly deliver.
 */
export const AUDIO_CAPABILITIES = {
  /**
   * NOT FEASIBLE WITH CURRENT AUDIO PIPELINE. Gapless playback requires the
   * next track's decoded audio to be scheduled while the current one is still
   * playing. Each MELO track is an independently resolved stream that a single
   * media element must (re)load — `el.src = url` necessarily tears down the
   * previous source, so a small transition gap always exists. Removing it
   * needs a Web Audio graph with pre-decoded, pre-scheduled buffers — an
   * engine replacement, which this project explicitly avoids.
   */
  gapless: false,

  /**
   * NOT FEASIBLE WITH CURRENT AUDIO PIPELINE. A crossfade needs two audible
   * voices (outgoing + incoming) ramped in opposite directions. There is one
   * HTMLAudioElement; fading it out silences the only voice, and the fade-in
   * target does not exist yet. Doing this safely requires a second parallel
   * playback element plus sync/takeover rules — effectively a second engine
   * (double media-key surfaces, session/position bookkeeping, ended-races).
   * Per the milestone rule ("do NOT add a second complicated playback
   * engine"), this is documented rather than half-implemented.
   */
  crossfade: false,

  /**
   * NOT FEASIBLE WITH CURRENT AUDIO PIPELINE. Real loudness normalization
   * needs a per-track loudness reference (ReplayGain/LUFS). The provider
   * supplies no loudness metadata, HTMLAudioElement exposes none, and
   * analysing decoded PCM would mean a DSP engine (out of scope). A plain
   * volume multiplier would be fake normalization and is deliberately absent:
   * MELO's volume control stays global and user-owned.
   */
  loudnessNormalization: false,
} as const

export type AudioCapability = keyof typeof AUDIO_CAPABILITIES
