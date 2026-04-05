import express from "express";
import cors from "cors";
import { kbRouter } from "./routes/kb";
import { env } from "./utils/env";
import { agentRouter } from "./routes/agent";

const app = express();

app.use(
  cors({
    origin: "*",
  })
);

app.use(express.json({ limit: "10mb" }));

app.use("/kb", kbRouter);
app.use("/agent", agentRouter);

app.listen(env.PORT, () => {
  console.log(`Server is running on port: ${env.PORT}`);
});
