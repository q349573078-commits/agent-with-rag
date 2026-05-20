import { Response, Router } from "express";
import { runProductAgentGraph } from "../agent/02_agent";
import {
  appendToHistory,
  ensureThreadId,
  getHistory,
} from "../agent/03_memory";

export const agentRouter = Router();

function writeSseEvent(
  res: Response,
  event: string,
  payload: unknown
) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

agentRouter.post("/chat", async (req, res) => {
  const {
    message,
    threadId: incomingThreadId,
    webSearchDecision,
  } = req.body as {
    message?: string;
    threadId?: string;
    webSearchDecision?: "confirm" | "cancel";
  };

  const isResumeRequest =
    webSearchDecision === "confirm" || webSearchDecision === "cancel";

  if (!isResumeRequest && (!message || !message.trim())) {
    return res.status(400).json({
      ok: false,
      message: "Message is required",
    });
  }

  if (isResumeRequest && !incomingThreadId) {
    return res.status(400).json({
      ok: false,
      message: "threadId is required when resuming a pending web search",
    });
  }

  const abortController = new AbortController();
  let clientDisconnected = false;

  const handleClientDisconnect = () => {
    if (clientDisconnected) {
      return;
    }

    clientDisconnected = true;
    abortController.abort();
  };

  req.on("aborted", handleClientDisconnect);
  res.on("close", () => {
    if (!res.writableEnded) {
      handleClientDisconnect();
    }
  });

  const assertNotAborted = () => {
    if (abortController.signal.aborted) {
      throw new Error("AbortError");
    }
  };

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    const threadId = await ensureThreadId(incomingThreadId);
    assertNotAborted();

    writeSseEvent(res, "thread", { threadId });

    let messagesForAgent: { role: "user" | "assistant"; content: string }[] =
      [];

    if (isResumeRequest) {
      writeSseEvent(res, "status", {
        stage:
          webSearchDecision === "confirm" ? "web_searching" : "cancelling",
      });
    } else {
      const history = await getHistory(threadId);
      assertNotAborted();

      const usermsg = {
        role: "user" as const,
        content: message!.trim(),
      };

      await appendToHistory(threadId, usermsg);
      assertNotAborted();

      messagesForAgent = [...history, usermsg];
      writeSseEvent(res, "status", { stage: "searching" });
    }

    const agentResult = await runProductAgentGraph({
      decision: isResumeRequest ? webSearchDecision : undefined,
      messages: isResumeRequest ? undefined : messagesForAgent,
      onStage: (stage) => {
        assertNotAborted();
        writeSseEvent(res, "status", { stage });
      },
      onToken: (token) => {
        assertNotAborted();
        writeSseEvent(res, "chunk", { content: token });
      },
      signal: abortController.signal,
      threadId,
    });

    assertNotAborted();

    if (agentResult.type === "interrupt") {
      writeSseEvent(res, "action_required", {
        threadId,
        ...agentResult.interrupt,
      });
      return res.end();
    }

    const assistantmsg = {
      role: "assistant" as const,
      content: agentResult.answer,
    };

    await appendToHistory(threadId, assistantmsg);

    writeSseEvent(res, "done", {
      ok: true,
      threadId,
      answer: agentResult.answer,
      citations: agentResult.citations,
    });
    return res.end();
  } catch (e: any) {
    if (abortController.signal.aborted) {
      if (!res.writableEnded) {
        res.end();
      }
      return;
    }

    console.log(e);
    writeSseEvent(res, "error", {
      ok: false,
      message: "Some error occured",
    });
    return res.end();
  } finally {
    req.off("aborted", handleClientDisconnect);
  }
});
