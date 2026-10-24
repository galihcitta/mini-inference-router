import { env } from "./config.ts";
import { migrate, releaseOrphans } from "./db/pool.ts";
import { buildApp } from "./http/app.ts";
import { issueDemoKeys } from "./gateway/auth.ts";
import { loadKb, Retriever } from "./support/kb.ts";

await migrate();
const orphans = await releaseOrphans();
const kb = loadKb();
const demoKeys = env.demoMode ? await issueDemoKeys() : [];
const app = buildApp(new Retriever(kb), demoKeys);
app.log.info({ kb: kb.length, orphans, anthropicKey: !!env.anthropicKey, demoMode: env.demoMode, demoTenants: demoKeys.length }, "starting");
await app.listen({ port: env.port, host: "0.0.0.0" });
