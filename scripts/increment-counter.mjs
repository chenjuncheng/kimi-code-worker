import { existsSync, readFileSync, writeFileSync } from "node:fs";

const path = process.argv[2];
const current = existsSync(path) ? Number(readFileSync(path, "utf8")) || 0 : 0;
writeFileSync(path, String(current + 1));
