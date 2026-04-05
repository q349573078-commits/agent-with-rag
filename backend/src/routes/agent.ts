import { Response, Router } from "express";
import { streamProductAgent } from "../agent/03_agent";
import {
  appendToHistory,
  ensureThreadId,
  getHistory,
} from "../agent/04_memory";

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
  const { message, threadId: incomingThreadId } = req.body as {
    message?: string;
    threadId?: string;
  };

  if (!message || !message.trim()) {
    return res.status(400).json({
      ok: false,
      message: "Message is required",
    });
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    const threadId = await ensureThreadId(incomingThreadId);
    writeSseEvent(res, "thread", { threadId });

    const history = await getHistory(threadId);

    const usermsg = {
      role: "user" as const,
      content: message.trim(),
    };

    await appendToHistory(threadId, usermsg);
    writeSseEvent(res, "status", { stage: "searching" });

    const messagesForAgent = [...history, usermsg];
    writeSseEvent(res, "status", { stage: "answering" });
    const { answer, citations } = await streamProductAgent(
      messagesForAgent,
      (token) => {
        writeSseEvent(res, "chunk", { content: token });
      }
    );

    const assistantmsg = {
      role: "assistant" as const,
      content: answer,
    };

    await appendToHistory(threadId, assistantmsg);

    writeSseEvent(res, "done", {
      ok: true,
      threadId,
      answer,
      citations,
    });
    return res.end();
  } catch (e: any) {
    console.log(e);
    writeSseEvent(res, "error", {
      ok: false,
      message: "Some error occured",
    });
    return res.end();
  }
});
