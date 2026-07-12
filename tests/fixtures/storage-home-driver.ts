import { existsSync } from "node:fs";
import { join } from "node:path";
import { addAssistantTask } from "../../src/assistant_tasks/store.ts";
import { MEMORY_DIR } from "../../src/memory/store.ts";

addAssistantTask({ title: "isolated benchmark task" });
console.log(JSON.stringify({ memoryDir: MEMORY_DIR, taskFile: join(MEMORY_DIR, "tasks.json"), exists: existsSync(join(MEMORY_DIR, "tasks.json")) }));
