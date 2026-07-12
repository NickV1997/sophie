import { addOnce, getScheduleItem, startScheduler } from "../../src/agent/scheduler.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const item = addOnce({ title: "retry", at: Date.now() - 1000, action: "notify", message: "hello" });
let attempts = 0;
const stop = startScheduler(async () => {
  attempts++;
  if (attempts === 1) throw new Error("simulated delivery failure");
}, 10);

await wait(8);
if (!getScheduleItem(item.id)?.enabled) throw new Error("failed delivery was acknowledged");
await wait(40);
stop();
if (attempts < 2) throw new Error(`expected retry, saw ${attempts} attempt(s)`);
if (getScheduleItem(item.id)?.enabled) throw new Error("successful retry was not acknowledged");
