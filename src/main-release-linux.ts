#!/usr/bin/env node

import { runCli } from "./main-release";

if (require.main === module) {
	process.exitCode = runCli(process.argv.slice(2));
}

export { runCli };