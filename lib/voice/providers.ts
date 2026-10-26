/**
 * Extension points for the later voice/avatar phase. Nothing here is wired up
 * yet. The browser agent only consumes and produces text, so voice plugs in
 * at the edges:
 *
 *   mic → SpeechInputProvider → text → sendMessage()      (chat-panel.tsx)
 *   assistant text parts → SpeechOutputProvider → audio
 *   audio/text → AvatarProvider → video element
 *
 * Note: AI Gateway routes model calls; it does not by itself provide a full
 * realtime voice or avatar pipeline. Each provider below needs its own service.
 */

export interface SpeechInputProvider {
  /** Start listening; emits partial and final transcripts. */
  start(opts: { onPartial(text: string): void; onFinal(text: string): void; onError(err: Error): void }): Promise<void>;
  stop(): Promise<void>;
}

export interface SpeechOutputProvider {
  /** Speak a completed assistant reply. Must be interruptible by Stop. */
  speak(text: string, opts?: { signal?: AbortSignal }): Promise<void>;
  cancel(): void;
}

export interface AvatarProvider {
  /** Attach the avatar stream to a container element. */
  mount(container: HTMLElement): Promise<void>;
  /** Lip-sync / animate to an utterance. */
  say(text: string, opts?: { signal?: AbortSignal }): Promise<void>;
  unmount(): Promise<void>;
}
