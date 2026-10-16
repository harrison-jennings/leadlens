import { rmSync } from "node:fs";

rmSync(new URL("./out-test", import.meta.url), { recursive: true, force: true });
