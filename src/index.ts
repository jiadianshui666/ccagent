#!/usr/bin/env node

import { startCli } from "./cli.js";

await startCli(process.argv.slice(2));
