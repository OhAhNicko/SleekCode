import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useOverlayToast } from "../../lib/useOverlayToast";
import { projectLeafName } from "../../lib/knowledge/keys";
import { KNOWLEDGE_CLI_PRODUCT_NAME } from "../../lib/knowledge/mcp";
import type { KnowledgeCli } from "../../lib/knowledge/types";

/**
 * The approve/deny surface for agent writes under the `ask` policy.
 *
 * The service parks the write, emits `made:knowledge-approval`, and waits;
 * `knowledge_respond_approval` releases it. Until 2026-08-08 NOTHING listened
 * to that event — the emitter, the responder command and the footer's pending
 * count all existed and were individually tested, while every ask-policy
 * write could only ever time out to a denial. Found live in runtime step 9.3,
 * after four static review waves missed the hole between two verified ends.
 *
 * An overlay toast, not a DOM card: the bottom-right of the window is native
 * pane territory, where DOM can never paint above the child HWNDs.
 *
 * Requests queue and show one at a time. Dismissing hides the CURRENT request
 * without answering it — the service's own window then denies it — and shows
 * the next. "Always" is the session-wide verdict the service already honors:
 * one approval for everything else this agent session writes.
 */
interface ApprovalRequest {
  requestId: string;
  projectPath: string;
  agentKind: string;
  method: string;
}

/** "add_decision" → "add decision" — honest even for methods added later. */
function humanizeMethod(method: string): string {
  return method.replace(/^knowledge_/, "").replace(/_/g, " ");
}

function agentName(kind: string): string {
  return KNOWLEDGE_CLI_PRODUCT_NAME[kind as KnowledgeCli] ?? kind;
}

export default function KnowledgeApprovalHost() {
  const [queue, setQueue] = useState<ApprovalRequest[]>([]);

  useEffect(() => {
    let un: UnlistenFn | undefined;
    // StrictMode-safe listen (the KnowledgeEngine pattern): the throwaway
    // mount's cleanup can run before the handle resolves.
    let disposed = false;
    void listen<Record<string, unknown>>("made:knowledge-approval", (event) => {
      if (disposed) return;
      const p = event.payload ?? {};
      const requestId = typeof p.requestId === "string" ? p.requestId : "";
      if (!requestId) return;
      const request: ApprovalRequest = {
        requestId,
        projectPath: typeof p.projectPath === "string" ? p.projectPath : "",
        agentKind: typeof p.agentKind === "string" ? p.agentKind : "",
        method: typeof p.method === "string" ? p.method : "write",
      };
      setQueue((prev) =>
        prev.some((r) => r.requestId === requestId) ? prev : [...prev, request],
      );
    }).then((handle) => {
      if (disposed) handle();
      else un = handle;
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  const current = queue[0] ?? null;

  const respond = (verdict: "approve" | "always" | "deny" | "dismiss") => {
    if (!current) return;
    if (verdict !== "dismiss") {
      // Fire-and-forget: a request the service already timed out answers with
      // a clean "no longer waiting" error, which is not the user's problem.
      void invoke("knowledge_respond_approval", {
        requestId: current.requestId,
        verdict,
      }).catch(() => {});
    }
    setQueue((prev) => prev.slice(1));
  };

  useOverlayToast({
    id: "knowledge-approval",
    open: !!current,
    payload: current
      ? {
          placement: "bottom-right",
          variant: "surface",
          title: `${agentName(current.agentKind)} wants to ${humanizeMethod(current.method)}`,
          // Labels match the SERVICE's real semantics (verified 2026-08-08):
          // "approve" grants the whole agent session, and "always" flips the
          // project's policy to trusted PERMANENTLY. The first cut said
          // "Approve" / "Always covers this session" — both understated.
          detail: `${projectLeafName(current.projectPath) || current.projectPath} — Allow covers this agent session · Trust stops asking for this project`,
          buttons: [
            { label: "Allow session", action: "approve", variant: "primary" },
            { label: "Trust project", action: "always", variant: "quiet" },
            { label: "Deny", action: "deny", variant: "danger" },
          ],
          dismissable: true,
        }
      : null,
    onAction: (action) => {
      if (action === "approve" || action === "always" || action === "deny") {
        respond(action);
      } else {
        respond("dismiss");
      }
    },
  });

  return null;
}
