import { env } from "./config.ts";
import { migrate, releaseOrphans } from "./db/pool.ts";
import { buildApp } from "./http/app.ts";
import { loadKb, Retriever } from "./support/kb.ts";

await migrate();
const orphans = await releaseOrphans();
const kb = loadKb();
const app = buildApp(new Retriever(kb));
app.log.info({ kb: kb.length, orphans, anthropicKey: !!env.anthropicKey }, "starting");
await app.listen({ port: env.port, host: "0.0.0.0" });
