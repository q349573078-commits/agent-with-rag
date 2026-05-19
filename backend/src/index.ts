import express from "express";
import cors from "cors";
import { kbRouter } from "./routes/kb";
import { env } from "./utils/env";
import { agentRouter } from "./routes/agent";
import { createServer } from "node:http";

const app = express();

app.use(
  cors({
    origin: "*",
  })
);

app.use(express.json({ limit: "10mb" }));

app.use("/kb", kbRouter);
app.use("/agent", agentRouter);

function listenWithFallback(args: {
  preferredPort: number;
  maxAttempts: number;
}): void {
  const { preferredPort, maxAttempts } = args;

  const tryListen = (port: number, remainingAttempts: number) => {
    const server = createServer(app);

    server.once("error", (error: any) => {
      if (error?.code === "EADDRINUSE" && remainingAttempts > 0) {
        const nextPort = port + 1;
        console.warn(
          `Port ${port} is already in use. Trying port ${nextPort}...`
        );
        return tryListen(nextPort, remainingAttempts - 1);
      }

      console.error(error);
      process.exit(1);
    });

    server.listen(port, () => {
      console.log(`Server is running on port: ${port}`);
    });
  };

  tryListen(preferredPort, maxAttempts - 1);
}

listenWithFallback({ preferredPort: env.PORT, maxAttempts: 20 });
