/**
 * Session layer — everything that has to survive across turns and restarts.
 *
 * Holds the running message history and offers the three context tools that
 * keep a long agent alive (they are semantically different, don't conflate):
 *   - checkpoint / resume : snapshot & restore the whole conversation
 *   - compact             : summarize early history into one block (frees tokens)
 *   - (context editing)   : callers may prune tool results via the same history
 */

import type { ModelMessage } from '../model';

/** Summarizes a slice of history into a single compact string. */
export type Summarizer = (messages: ModelMessage[]) => Promise<string>;

export interface SessionSnapshot {
  id: string;
  createdAt: string;
  messages: ModelMessage[];
}

export interface SessionOptions {
  id?: string;
  system?: string;
  /** compact once history grows past this many messages */
  compactThreshold?: number;
  /** keep this many most-recent messages verbatim when compacting */
  keepRecent?: number;
}

export class Session {
  readonly id: string;
  readonly system?: string;
  private messages: ModelMessage[] = [];
  private compactThreshold: number;
  private keepRecent: number;

  constructor(opts: SessionOptions = {}) {
    this.id = opts.id ?? `sess_${Date.now().toString(36)}`;
    this.system = opts.system;
    this.compactThreshold = opts.compactThreshold ?? 60;
    this.keepRecent = opts.keepRecent ?? 12;
  }

  add(msg: ModelMessage): void {
    this.messages.push(msg);
  }

  history(): ModelMessage[] {
    return this.messages;
  }

  get length(): number {
    return this.messages.length;
  }

  /** Snapshot for --resume / persistence. */
  checkpoint(): SessionSnapshot {
    return {
      id: this.id,
      createdAt: new Date().toISOString(),
      messages: JSON.parse(JSON.stringify(this.messages)),
    };
  }

  /** Restore a prior snapshot in place. */
  resume(snap: SessionSnapshot): void {
    this.messages = JSON.parse(JSON.stringify(snap.messages));
  }

  static from(snap: SessionSnapshot, opts: SessionOptions = {}): Session {
    const s = new Session({ ...opts, id: snap.id });
    s.resume(snap);
    return s;
  }

  /**
   * Compaction: replace all-but-the-most-recent history with one summary block.
   * The summary is appended as a user note so the model keeps the thread.
   * No-op until history exceeds the threshold.
   */
  async maybeCompact(summarize: Summarizer): Promise<boolean> {
    if (this.messages.length <= this.compactThreshold) return false;
    const cut = this.messages.length - this.keepRecent;
    const older = this.messages.slice(0, cut);
    const recent = this.messages.slice(cut);
    const summary = await summarize(older);
    this.messages = [
      { role: 'user', content: `[Compacted summary of earlier conversation]\n${summary}` },
      ...recent,
    ];
    return true;
  }
}
