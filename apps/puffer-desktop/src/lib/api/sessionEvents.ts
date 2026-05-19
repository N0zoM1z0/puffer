import { ensureLocalDaemonClient } from "./daemonClient";

/** Any session event may arrive with `replay: true` when the daemon is
 *  catching up a newly-connected client via the replay ring buffer. UIs
 *  that already dedupe by stable id (tool cards by callId) don't need to
 *  branch on this. Assistant deltas use the flag to avoid duplicating text
 *  already preserved through a reconnect, and handlers that would otherwise
 *  toast / bump notifications can suppress those side effects on replay. */
export type SessionStreamEvent =
  | { type: "turn-start"; turnId: string; replay?: boolean }
  | { type: "text-delta"; turnId: string; delta: string; replay?: boolean }
  | { type: "thinking-delta"; turnId: string; delta: string; replay?: boolean }
  | {
      type: "tool-calls-requested";
      turnId: string;
      requests: { callId: string; toolId: string; input: string }[];
      replay?: boolean;
    }
  | {
      type: "tool-invocations";
      turnId: string;
      invocations: {
        callId: string;
        toolId: string;
        input: string;
        output: string;
        success: boolean;
      }[];
      replay?: boolean;
    }
  | {
      type: "usage";
      turnId: string;
      report: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
      };
      replay?: boolean;
    }
  | { type: "reflection-checkpoint"; turnId: string; summary: string; replay?: boolean }
  | {
      type: "retry-attempt";
      turnId: string;
      attempt: number;
      maxAttempts: number;
      error: string;
      replay?: boolean;
    }
  | {
      type: "permission-request";
      turnId: string;
      requestId: string;
      toolId: string;
      summary: string;
      reason: string | null;
      replay?: boolean;
    }
  | {
      type: "user-question-request";
      turnId: string;
      requestId: string;
      questions: unknown[];
      replay?: boolean;
    }
  | { type: "turn-complete"; turnId: string; assistantText: string; replay?: boolean }
  | { type: "turn-error"; turnId: string; error: string; replay?: boolean };

type Unlisten = () => void;

/** Subscribes to all events for one session via the daemon WebSocket.
 *  Returns a disposer. If the daemon isn't reachable (pure web without a
 *  daemon URL), returns a no-op disposer — callers don't need to branch. */
export async function subscribeSessionEvents(
  sessionId: string,
  handler: (event: SessionStreamEvent) => void
): Promise<Unlisten> {
  try {
    const client = await ensureLocalDaemonClient();
    const channel = `session:${sessionId}:event`;
    return client.on(channel, (payload) => {
      handler(payload as SessionStreamEvent);
    });
  } catch (_e) {
    return () => {};
  }
}
