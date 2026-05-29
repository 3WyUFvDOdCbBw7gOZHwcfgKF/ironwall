const assert = require("node:assert");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const defaultSuiteRoot = path.join(repoRoot, "Temp", "JSONTestSuite-master");
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const TIME_PATH = "/usr/bin/time";
const PRLIMIT_PATH = "/usr/bin/prlimit";
const TIMEOUT_PATH = "/usr/bin/timeout";
const EXTERNAL_COMMAND_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const DEFAULT_EXTERNAL_TIMEOUT_MS = 12000;
const DEFAULT_EXTERNAL_MAX_RSS_KB = 128 * 1024;
const DEFAULT_EXTERNAL_MAX_ADDRESS_SPACE_KB = 192 * 1024;
const recordedTransformCases = new Map([
	[
		"object_same_key_unclear_values.json",
		"duplicate-key numeric canonicalization may collapse -0 to 0 during stringify"
	],
	[
		"string_1_invalid_codepoint.json",
		"strict UTF-8 decoding may reject invalid codepoint input before round-trip"
	],
	[
		"string_2_invalid_codepoints.json",
		"strict UTF-8 decoding may reject invalid codepoint input before round-trip"
	],
	[
		"string_3_invalid_codepoints.json",
		"strict UTF-8 decoding may reject invalid codepoint input before round-trip"
	]
]);

function fail(message) {
	throw new Error(message);
}

function parseArgs(argv) {
	const options = {
		suiteRoot: defaultSuiteRoot,
		mode: "parsing",
		runner: "node-json",
		includeImplDefined: true,
		maxFailures: 20,
		filter: null,
		validatorCommand: null,
		transformCommand: null,
		printFailures: true,
		externalTimeoutMs: DEFAULT_EXTERNAL_TIMEOUT_MS,
		externalMaxRssKb: DEFAULT_EXTERNAL_MAX_RSS_KB,
		externalMaxAddressSpaceKb: DEFAULT_EXTERNAL_MAX_ADDRESS_SPACE_KB,
		resourceSummaryJson: null
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--suite-root") {
			index += 1;
			options.suiteRoot = requireValue(argv, index, arg);
		} else if (arg === "--mode") {
			index += 1;
			options.mode = requireValue(argv, index, arg);
		} else if (arg === "--runner") {
			index += 1;
			options.runner = requireValue(argv, index, arg);
		} else if (arg === "--validator-command") {
			index += 1;
			options.validatorCommand = requireValue(argv, index, arg);
		} else if (arg === "--transform-command") {
			index += 1;
			options.transformCommand = requireValue(argv, index, arg);
		} else if (arg === "--max-failures") {
			index += 1;
			options.maxFailures = Number.parseInt(requireValue(argv, index, arg), 10);
		} else if (arg === "--external-timeout-ms") {
			index += 1;
			options.externalTimeoutMs = Number.parseInt(requireValue(argv, index, arg), 10);
		} else if (arg === "--external-max-rss-kb") {
			index += 1;
			options.externalMaxRssKb = Number.parseInt(requireValue(argv, index, arg), 10);
		} else if (arg === "--external-max-address-space-kb") {
			index += 1;
			options.externalMaxAddressSpaceKb = Number.parseInt(requireValue(argv, index, arg), 10);
		} else if (arg === "--resource-summary-json") {
			index += 1;
			options.resourceSummaryJson = requireValue(argv, index, arg);
		} else if (arg === "--filter") {
			index += 1;
			options.filter = new RegExp(requireValue(argv, index, arg), "i");
		} else if (arg === "--exclude-impl-defined") {
			options.includeImplDefined = false;
		} else if (arg === "--no-print-failures") {
			options.printFailures = false;
		} else if (arg === "--help") {
			options.help = true;
		} else {
			fail(`unknown argument: ${arg}`);
		}
	}

	if (!["parsing", "transform", "all"].includes(options.mode)) {
		fail(`unsupported mode: ${options.mode}`);
	}
	if (!["node-json", "external-command"].includes(options.runner)) {
		fail(`unsupported runner: ${options.runner}`);
	}
	if (!Number.isInteger(options.maxFailures) || options.maxFailures < 1) {
		fail(`expected positive integer --max-failures, got ${options.maxFailures}`);
	}
	if (!Number.isInteger(options.externalTimeoutMs) || options.externalTimeoutMs < 1) {
		fail(`expected positive integer --external-timeout-ms, got ${options.externalTimeoutMs}`);
	}
	if (options.externalMaxRssKb !== null && (!Number.isInteger(options.externalMaxRssKb) || options.externalMaxRssKb < 1)) {
		fail(`expected positive integer --external-max-rss-kb, got ${options.externalMaxRssKb}`);
	}
	if (
		options.externalMaxAddressSpaceKb !== null
		&& (!Number.isInteger(options.externalMaxAddressSpaceKb) || options.externalMaxAddressSpaceKb < 1)
	) {
		fail(`expected positive integer --external-max-address-space-kb, got ${options.externalMaxAddressSpaceKb}`);
	}
	if (options.runner === "external-command") {
		if ((options.mode === "parsing" || options.mode === "all") && !options.validatorCommand) {
			fail("--validator-command is required for parsing with --runner external-command");
		}
		if (options.mode === "transform" && !options.transformCommand && !options.validatorCommand) {
			fail("--transform-command is required for transform with --runner external-command");
		}
		if (process.platform !== "linux") {
			fail("--runner external-command currently requires Linux resource wrappers in this workspace");
		}
		if (!fs.existsSync(TIME_PATH)) {
			fail(`missing required tool: ${TIME_PATH}`);
		}
		if (!fs.existsSync(TIMEOUT_PATH)) {
			fail(`missing required tool: ${TIMEOUT_PATH}`);
		}
		if (options.externalMaxAddressSpaceKb !== null && !fs.existsSync(PRLIMIT_PATH)) {
			fail(`missing required tool for --external-max-address-space-kb: ${PRLIMIT_PATH}`);
		}
	}

	return options;
}

function requireValue(argv, index, flag) {
	const value = argv[index];
	if (value === undefined) {
		fail(`missing value after ${flag}`);
	}
	return value;
}

function printHelp() {
	process.stdout.write(
		[
			"Usage: node src/examples/json-lib/validate-json-suite.js [options]",
			"",
			"Options:",
			"  --suite-root <path>          JSONTestSuite root (default: Temp/JSONTestSuite-master)",
			"  --mode <parsing|transform|all>",
			"  --runner <node-json|external-command>",
			"  --validator-command <cmd>    External command with {file} placeholder or appended file path",
			"  --transform-command <cmd>    External transform command with {file} placeholder or appended file path",
			"  --filter <regex>             Only run matching file basenames",
			"  --max-failures <n>           Stop after n hard failures",
			`  --external-timeout-ms <n>    Per-case timeout for external commands (default: ${String(DEFAULT_EXTERNAL_TIMEOUT_MS)})`,
			`  --external-max-rss-kb <n>    Fail if peak RSS exceeds n KB (default: ${String(DEFAULT_EXTERNAL_MAX_RSS_KB)})`,
			`  --external-max-address-space-kb <n>  Run external commands under an address-space cap (default: ${String(DEFAULT_EXTERNAL_MAX_ADDRESS_SPACE_KB)})`,
			"  --resource-summary-json <p>  Write per-mode resource summary JSON to path",
			"  --exclude-impl-defined       Skip i_* parsing cases from execution",
			"  --no-print-failures          Suppress per-case failure lines",
			"  --help",
			"",
			"Runner semantics:",
			"  node-json         Uses JSON.parse / JSON.stringify as a host-side baseline.",
			"  external-command  Exit code 0 means accepted, nonzero means rejected.",
			`                    Default guard: ${String(DEFAULT_EXTERNAL_TIMEOUT_MS)}ms timeout, ${String(DEFAULT_EXTERNAL_MAX_RSS_KB)}KB RSS, ${String(DEFAULT_EXTERNAL_MAX_ADDRESS_SPACE_KB)}KB address space.`,
			""
		].join("\n")
	);
}

function listJsonFiles(dirPath) {
	return fs
		.readdirSync(dirPath)
		.filter((name) => name.endsWith(".json"))
		.sort((left, right) => left.localeCompare(right))
		.map((name) => path.join(dirPath, name));
}

function classifyParsingCase(filePath) {
	const baseName = path.basename(filePath);
	const prefix = baseName.slice(0, 2);
	if (prefix === "y_") {
		return "accept";
	}
	if (prefix === "n_") {
		return "reject";
	}
	if (prefix === "i_") {
		return "impl-defined";
	}
	fail(`unrecognized parsing test prefix for ${baseName}`);
}

function loadCaseBuffer(filePath) {
	return fs.readFileSync(filePath);
}

function decodeJsonUtf8(buffer) {
	return utf8Decoder.decode(buffer);
}

function runNodeJsonParse(filePath) {
	try {
		const text = decodeJsonUtf8(loadCaseBuffer(filePath));
		JSON.parse(text);
		return { accepted: true, detail: "accepted by JSON.parse" };
	} catch (error) {
		return { accepted: false, detail: error.message };
	}
}

function shellQuote(value) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildExternalCommand(commandTemplate, filePath) {
	if (commandTemplate.includes("{file}")) {
		return commandTemplate.replaceAll("{file}", shellQuote(filePath));
	}
	return `${commandTemplate} ${shellQuote(filePath)}`;
}

function parseMaximumResidentSetSize(statsText) {
	const statsMatch = /^\s*Maximum resident set size \(kbytes\):\s*(\d+)\s*$/m.exec(statsText);
	if (statsMatch === null) {
		throw new Error(`missing maximum resident set size in time output\n${statsText}`);
	}
	const rssKb = Number.parseInt(statsMatch[1], 10);
	if (!Number.isFinite(rssKb) || rssKb <= 0) {
		throw new Error(`invalid maximum resident set size '${statsMatch[1]}'`);
	}
	return rssKb;
}

function buildExternalRunnerArgs(command, options, statsPath) {
	const args = ["-v", "-o", statsPath];
	args.push(
		TIMEOUT_PATH,
		"--signal=TERM",
		"--kill-after=5s",
		`${String(Math.max(1, Math.ceil(options.externalTimeoutMs / 1000)))}s`,
		"bash",
		"-lc",
		command
	);
	return args;
}

function runExternalCommand(commandTemplate, filePath, options) {
	const command = buildExternalCommand(commandTemplate, filePath);
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ironwall-json-suite-"));
	const statsPath = path.join(tempDir, "time.txt");
	const startedAt = process.hrtime.bigint();
	try {
		const result = cp.spawnSync(TIME_PATH, buildExternalRunnerArgs(command, options, statsPath), {
			cwd: repoRoot,
			encoding: "utf8",
			env: {
				...process.env,
				IRONWALL_JSON_CHILD_TIMEOUT_MS: String(options.externalTimeoutMs),
				...(options.externalMaxAddressSpaceKb === null
					? {}
					: { IRONWALL_JSON_CHILD_MAX_ADDRESS_SPACE_KB: String(options.externalMaxAddressSpaceKb) })
			},
			maxBuffer: EXTERNAL_COMMAND_MAX_BUFFER_BYTES,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: options.externalTimeoutMs + 15000
		});
		if (result.error && result.error.code !== "ETIMEDOUT") {
			throw result.error;
		}

		const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
		const stdout = result.stdout ?? "";
		const stderr = result.stderr ?? "";
		const statsText = fs.existsSync(statsPath) ? fs.readFileSync(statsPath, "utf8") : null;
		const rssKb = statsText === null ? null : parseMaximumResidentSetSize(statsText);
		const timedOut = result.status === 124 || result.error?.code === "ETIMEDOUT";
		let resourceFailure = null;
		if (timedOut) {
			resourceFailure = `timeout after ${options.externalTimeoutMs}ms`;
		} else if (result.signal !== null) {
			resourceFailure = `terminated by signal ${result.signal}`;
		} else if (options.externalMaxRssKb !== null && rssKb !== null && rssKb > options.externalMaxRssKb) {
			resourceFailure = `peak RSS ${rssKb}KB exceeded limit ${options.externalMaxRssKb}KB`;
		}

		return {
			status: result.status,
			signal: result.signal,
			stdout,
			stderr,
			durationMs,
			rssKb,
			resourceFailure,
			detail: (stderr || stdout).trim() || `exit ${result.status ?? "unknown"}`
		};
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

function runExternalParse(commandTemplate, filePath, options) {
	const run = runExternalCommand(commandTemplate, filePath, options);
	return {
		accepted: run.resourceFailure === null && run.signal === null && run.status === 0,
		detail: run.resourceFailure ?? run.detail,
		resourceFailure: run.resourceFailure,
		durationMs: run.durationMs,
		rssKb: run.rssKb
	};
}

function createParsingRunner(options) {
	if (options.runner === "node-json") {
		return runNodeJsonParse;
	}
	return (filePath) => runExternalParse(options.validatorCommand, filePath, options);
}

function createTransformRunner(options) {
	if (options.runner === "node-json") {
		return (filePath) => {
			const text = decodeJsonUtf8(loadCaseBuffer(filePath));
			const parsed = JSON.parse(text);
			const stringified = JSON.stringify(parsed);
			const reparsed = JSON.parse(stringified);
			assert.deepStrictEqual(reparsed, parsed, `${path.basename(filePath)}: reparsed value mismatch`);
			return {
				ok: true,
				stringifiedBytes: Buffer.byteLength(stringified, "utf8")
			};
		};
	}
	if (options.runner === "external-command") {
		return (filePath) => {
			const inputText = decodeJsonUtf8(loadCaseBuffer(filePath));
			const parsed = JSON.parse(inputText);
			const run = runExternalCommand(options.transformCommand || options.validatorCommand, filePath, options);
			if (run.resourceFailure !== null) {
				throw new Error(run.resourceFailure);
			}
			if (run.signal !== null) {
				throw new Error(`terminated by signal ${run.signal}`);
			}
			if (run.status !== 0) {
				throw new Error(run.detail);
			}
			const stringified = run.stdout;
			const reparsed = JSON.parse(stringified);
			assert.deepStrictEqual(reparsed, parsed, `${path.basename(filePath)}: reparsed value mismatch`);
			return {
				ok: true,
				stringifiedBytes: Buffer.byteLength(stringified, "utf8"),
				durationMs: run.durationMs,
				rssKb: run.rssKb
			};
		};
	}
	return null;
}

function createResourceSummary() {
	return {
		caseCount: 0,
		maxDurationMs: 0,
		maxDurationCase: null,
		maxRssKb: 0,
		maxRssCase: null,
		resourceFailureCount: 0,
		timeoutCount: 0,
		rssLimitExceededCount: 0
	};
}

function updateResourceSummary(resourceSummary, baseName, run) {
	if (run.durationMs !== undefined) {
		resourceSummary.caseCount += 1;
		if (run.durationMs > resourceSummary.maxDurationMs) {
			resourceSummary.maxDurationMs = run.durationMs;
			resourceSummary.maxDurationCase = baseName;
		}
	}
	if (run.rssKb !== undefined && run.rssKb !== null && run.rssKb > resourceSummary.maxRssKb) {
		resourceSummary.maxRssKb = run.rssKb;
		resourceSummary.maxRssCase = baseName;
	}
	if (typeof run.resourceFailure === "string") {
		resourceSummary.resourceFailureCount += 1;
		if (run.resourceFailure.startsWith("timeout after ")) {
			resourceSummary.timeoutCount += 1;
		}
		if (run.resourceFailure.startsWith("peak RSS ")) {
			resourceSummary.rssLimitExceededCount += 1;
		}
	}
}

function shouldIncludeCase(filePath, filter) {
	if (!filter) {
		return true;
	}
	return filter.test(path.basename(filePath));
}

function summarizeParsingResults(results) {
	const summary = {
		total: results.length,
		acceptExpected: 0,
		rejectExpected: 0,
		implDefined: 0,
		passed: 0,
		failed: 0,
		accepted: 0,
		rejected: 0,
		implAccepted: 0,
		implRejected: 0
	};

	for (const result of results) {
		if (result.expectation === "accept") {
			summary.acceptExpected += 1;
		} else if (result.expectation === "reject") {
			summary.rejectExpected += 1;
		} else {
			summary.implDefined += 1;
		}

		if (result.accepted) {
			summary.accepted += 1;
			if (result.expectation === "impl-defined") {
				summary.implAccepted += 1;
			}
		} else {
			summary.rejected += 1;
			if (result.expectation === "impl-defined") {
				summary.implRejected += 1;
			}
		}

		if (result.outcome === "pass") {
			summary.passed += 1;
		}
		if (result.outcome === "fail") {
			summary.failed += 1;
		}
	}

	return summary;
}

function runParsingSuite(options) {
	const parsingDir = path.join(options.suiteRoot, "test_parsing");
	const runner = createParsingRunner(options);
	const results = [];
	const resourceSummary = createResourceSummary();
	let hardFailures = 0;

	for (const filePath of listJsonFiles(parsingDir)) {
		if (!shouldIncludeCase(filePath, options.filter)) {
			continue;
		}
		const expectation = classifyParsingCase(filePath);
		if (expectation === "impl-defined" && !options.includeImplDefined) {
			continue;
		}

		const run = runner(filePath);
		updateResourceSummary(resourceSummary, path.basename(filePath), run);
		const accepted = run.accepted;
		const outcome =
			run.resourceFailure
				? "fail"
				: expectation === "impl-defined"
				? "recorded"
				: accepted === (expectation === "accept")
					? "pass"
					: "fail";

		const result = {
			filePath,
			baseName: path.basename(filePath),
			expectation,
			accepted,
			outcome,
			detail: run.detail || ""
		};
		results.push(result);

		if (outcome === "fail") {
			hardFailures += 1;
			if (options.printFailures) {
				process.stdout.write(`FAIL parsing ${result.baseName} expected=${expectation} accepted=${accepted} detail=${result.detail}\n`);
			}
			if (hardFailures >= options.maxFailures) {
				break;
			}
		}
	}

	return {
		results,
		summary: summarizeParsingResults(results),
		resourceSummary,
		stoppedEarly: hardFailures >= options.maxFailures
	};
}

function runTransformSuite(options) {
	const transformDir = path.join(options.suiteRoot, "test_transform");
	const runner = createTransformRunner(options);
	if (!runner) {
		return {
			skipped: true,
			reason: `runner ${options.runner} does not implement transform mode`
		};
	}

	const results = [];
	const resourceSummary = createResourceSummary();
	let failures = 0;
	for (const filePath of listJsonFiles(transformDir)) {
		if (!shouldIncludeCase(filePath, options.filter)) {
			continue;
		}
		try {
			const run = runner(filePath);
			updateResourceSummary(resourceSummary, path.basename(filePath), run);
			results.push({
				filePath,
				baseName: path.basename(filePath),
				outcome: "pass",
				stringifiedBytes: run.stringifiedBytes
			});
		} catch (error) {
			const baseName = path.basename(filePath);
			const recordedReason = recordedTransformCases.get(baseName);
			const result = {
				filePath,
				baseName,
				outcome: recordedReason ? "recorded" : "fail",
				recordedReason,
				detail: error.message
			};
			results.push(result);
			if (result.outcome === "fail") {
				failures += 1;
			}
			if (options.printFailures) {
				if (result.outcome === "recorded") {
					process.stdout.write(`RECORD transform ${result.baseName} reason=${result.recordedReason} detail=${result.detail}\n`);
				} else {
					process.stdout.write(`FAIL transform ${result.baseName} detail=${result.detail}\n`);
				}
			}
			if (failures >= options.maxFailures) {
				break;
			}
		}
	}

	return {
		skipped: false,
		results,
		resourceSummary,
		summary: {
			total: results.length,
			passed: results.filter((result) => result.outcome === "pass").length,
			recorded: results.filter((result) => result.outcome === "recorded").length,
			failed: results.filter((result) => result.outcome === "fail").length
		},
		stoppedEarly: failures >= options.maxFailures
	};
}

function ensureSuiteExists(suiteRoot) {
	const parsingDir = path.join(suiteRoot, "test_parsing");
	const transformDir = path.join(suiteRoot, "test_transform");
	if (!fs.existsSync(parsingDir)) {
		fail(`missing JSONTestSuite parsing directory: ${parsingDir}`);
	}
	if (!fs.existsSync(transformDir)) {
		fail(`missing JSONTestSuite transform directory: ${transformDir}`);
	}
}

function printParsingSummary(parsingRun) {
	const { summary } = parsingRun;
	process.stdout.write(
		[
			"parsing summary",
			`  total: ${summary.total}`,
			`  y_* expected accept: ${summary.acceptExpected}`,
			`  n_* expected reject: ${summary.rejectExpected}`,
			`  i_* implementation-defined: ${summary.implDefined}`,
			`  passed: ${summary.passed}`,
			`  failed: ${summary.failed}`,
			`  accepted: ${summary.accepted}`,
			`  rejected: ${summary.rejected}`,
			`  impl-accepted: ${summary.implAccepted}`,
			`  impl-rejected: ${summary.implRejected}`
		].join("\n") + "\n"
	);
	if (parsingRun.resourceSummary.caseCount > 0) {
		process.stdout.write(
			[
				"  resource cases: " + String(parsingRun.resourceSummary.caseCount),
				"  peak duration ms: " + parsingRun.resourceSummary.maxDurationMs.toFixed(2) + (parsingRun.resourceSummary.maxDurationCase ? ` (${parsingRun.resourceSummary.maxDurationCase})` : ""),
				"  peak RSS KB: " + String(parsingRun.resourceSummary.maxRssKb) + (parsingRun.resourceSummary.maxRssCase ? ` (${parsingRun.resourceSummary.maxRssCase})` : ""),
				"  resource failures: " + String(parsingRun.resourceSummary.resourceFailureCount),
				"  timeouts: " + String(parsingRun.resourceSummary.timeoutCount),
				"  rss limit exceeded: " + String(parsingRun.resourceSummary.rssLimitExceededCount)
			].join("\n") + "\n"
		);
	}
	if (parsingRun.stoppedEarly) {
		process.stdout.write("stopped early after reaching --max-failures\n");
	}
}

function printTransformSummary(transformRun) {
	if (transformRun.skipped) {
		process.stdout.write(`transform summary\n  skipped: ${transformRun.reason}\n`);
		return;
	}
	process.stdout.write(
		[
			"transform summary",
			`  total: ${transformRun.summary.total}`,
			`  passed: ${transformRun.summary.passed}`,
			`  recorded: ${transformRun.summary.recorded}`,
			`  failed: ${transformRun.summary.failed}`
		].join("\n") + "\n"
	);
	if (transformRun.resourceSummary.caseCount > 0) {
		process.stdout.write(
			[
				"  resource cases: " + String(transformRun.resourceSummary.caseCount),
				"  peak duration ms: " + transformRun.resourceSummary.maxDurationMs.toFixed(2) + (transformRun.resourceSummary.maxDurationCase ? ` (${transformRun.resourceSummary.maxDurationCase})` : ""),
				"  peak RSS KB: " + String(transformRun.resourceSummary.maxRssKb) + (transformRun.resourceSummary.maxRssCase ? ` (${transformRun.resourceSummary.maxRssCase})` : ""),
				"  resource failures: " + String(transformRun.resourceSummary.resourceFailureCount),
				"  timeouts: " + String(transformRun.resourceSummary.timeoutCount),
				"  rss limit exceeded: " + String(transformRun.resourceSummary.rssLimitExceededCount)
			].join("\n") + "\n"
		);
	}
	if (transformRun.stoppedEarly) {
		process.stdout.write("stopped early after reaching --max-failures\n");
	}
}

function writeResourceSummary(options, parsingRun, transformRun) {
	if (!options.resourceSummaryJson) {
		return;
	}
	const payload = {
		parsing: parsingRun === null ? null : parsingRun.resourceSummary,
		transform: transformRun === null || transformRun.skipped ? null : transformRun.resourceSummary
	};
	fs.writeFileSync(options.resourceSummaryJson, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		printHelp();
		return;
	}

	ensureSuiteExists(options.suiteRoot);

	let exitCode = 0;
	let parsingRun = null;
	let transformRun = null;
	if (options.mode === "parsing" || options.mode === "all") {
		parsingRun = runParsingSuite(options);
		printParsingSummary(parsingRun);
		if (parsingRun.summary.failed > 0) {
			exitCode = 1;
		}
	}
	if (options.mode === "transform" || options.mode === "all") {
		transformRun = runTransformSuite(options);
		printTransformSummary(transformRun);
		if (!transformRun.skipped && transformRun.summary.failed > 0) {
			exitCode = 1;
		}
	}
	writeResourceSummary(options, parsingRun, transformRun);

	process.exitCode = exitCode;
}

main();