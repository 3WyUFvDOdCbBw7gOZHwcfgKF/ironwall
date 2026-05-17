import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { ok, strictEqual } from "assert";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { assertRunResult, execBuildJsonCliSync, spawnBuildJsonCliSync } from "./BuildJsonCliHarness";

interface BackendRun {
    readonly label: string;
    readonly runArgs: readonly string[];
}

interface SuccessCase {
    readonly name: string;
    readonly fileName: string;
    readonly entry: string;
    readonly expectedLines: readonly string[];
    readonly prepare: () => void;
    readonly verify: () => void;
}

interface ExitCase {
    readonly name: string;
    readonly fileName: string;
    readonly entry: string;
    readonly expectedExitCode: number;
}

const TEST_TIMEOUT_MS: number = 15000;
const MAX_BUFFER_BYTES: number = 16 * 1024 * 1024;
const repoRoot: string = resolve(__dirname, "..", "..");
const cliPath: string = join(repoRoot, "build", "main.js");
const fixtureDir: string = join(repoRoot, "src", "Test-Linux", "Fixtures", "std-sys");
const artifactDir: string = join(repoRoot, "artifacts", "std-sys");
const inputPath: string = join(artifactDir, "input.txt");
const openAtInputPath: string = join(artifactDir, "openat_input.txt");
const openWritePath: string = join(artifactDir, "open_write.txt");
const openAtWritePath: string = join(artifactDir, "openat_write.txt");
const writePath: string = join(artifactDir, "write.txt");
const creatPath: string = join(artifactDir, "creat.txt");
const preadPath: string = join(artifactDir, "pread.txt");
const pwritePath: string = join(artifactDir, "pwrite.txt");
const seekPath: string = join(artifactDir, "seek.txt");
const fsyncPath: string = join(artifactDir, "fsync.txt");
const fdatasyncPath: string = join(artifactDir, "fdatasync.txt");
const fstatPath: string = join(artifactDir, "fstat.txt");
const mkdirPath: string = join(artifactDir, "mkdir-target");
const rmdirPath: string = join(artifactDir, "rmdir-target");
const unlinkPath: string = join(artifactDir, "unlink.txt");
const renameSourcePath: string = join(artifactDir, "rename-from.txt");
const renameTargetPath: string = join(artifactDir, "rename-to.txt");
const cwdTargetDirPath: string = join(artifactDir, "cwd-target");
const cwdTargetFilePath: string = join(cwdTargetDirPath, "cwd.txt");
const sendfilePath: string = join(artifactDir, "sendfile.txt");
const inputText: string = "alpha-beta";
const openAtInputText: string = "openat-alpha";
const staleText: string = "stale-data";
const writeText: string = "write-text";
const openAtWriteText: string = "openat-write";
const creatText: string = "creat-text";
const preadText: string = "0123456789";
const pwriteSparseText: string = "\u0000\u0000abc";
const seekText: string = "0123456789";
const fsyncText: string = "fsync-text";
const fdatasyncText: string = "fdatasync-text";
const fstatText: string = "fstat-text";
const cwdTargetText: string = "cwd-ok";
const sendfileText: string = "sendfile-text";
const x64FrontendArgs: readonly string[] = ["--frontend-profile", "no-optimized"];

const successRuns: readonly BackendRun[] = [
    {
        label: "c-backend",
        runArgs: ["--backend-profile", "c-backend"]
    },
    {
        label: "optimized-x64-backend",
        runArgs: [...x64FrontendArgs, "--backend-profile", "optimized-x64-backend"]
    },
    {
        label: "no-optimized-backend",
        runArgs: [...x64FrontendArgs, "--backend-profile", "no-optimized-backend"]
    }
];

const exitRuns: readonly BackendRun[] = [
    {
        label: "c-backend",
        runArgs: ["--backend-profile", "c-backend"]
    }
];

function prepareArtifactDir(): void {
    rmSync(artifactDir, { recursive: true, force: true });
    mkdirSync(artifactDir, { recursive: true });
}

function runSuccessCase(successCase: SuccessCase, run: BackendRun): void {
    successCase.prepare();
    const result = spawnBuildJsonCliSync(cliPath, [
        "run",
        fixtureDir,
        "--entry",
        successCase.entry,
        ...run.runArgs
    ], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });

    assertRunResult(result, [], Number(successCase.expectedLines[0]) & 0xff, `${run.label} ${successCase.name}`);
    successCase.verify();
    process.stdout.write(`std-sys ${successCase.name} ${run.label} ok\n`);
}

function runExitCase(exitCase: ExitCase, run: BackendRun): void {
    prepareArtifactDir();
    const tempDir: string = mkdtempSync(join(tmpdir(), "ironwall-std-sys-"));
    const sourcePath: string = join(tempDir, "program.c");
    const binaryPath: string = join(tempDir, "program.out");
    try {
        const source: string = execBuildJsonCliSync(cliPath, [
            "emit-c",
            fixtureDir,
            "--entry",
            exitCase.entry,
            ...run.runArgs
        ], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: MAX_BUFFER_BYTES,
            timeout: TEST_TIMEOUT_MS
        });
        writeFileSync(sourcePath, source, "utf8");
        execFileSync("cc", ["-w", "-std=c11", "-O0", "-pthread", sourcePath, "-o", binaryPath], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: MAX_BUFFER_BYTES,
            timeout: TEST_TIMEOUT_MS
        });

        try {
            execFileSync(binaryPath, [], {
                cwd: repoRoot,
                encoding: "utf8",
                maxBuffer: MAX_BUFFER_BYTES,
                timeout: TEST_TIMEOUT_MS
            });
            throw new Error(`${run.label} ${exitCase.name} unexpectedly completed successfully`);
        } catch (error) {
            if (error instanceof Error && error.message.includes("unexpectedly completed successfully")) {
                throw error;
            }
            const execError = error as Error & { status?: number | null; signal?: NodeJS.Signals | null; stdout?: string; stderr?: string };
            strictEqual(execError.signal ?? null, null, `${run.label} ${exitCase.name} should exit normally, got signal=${String(execError.signal)} stderr=${execError.stderr ?? ""}`);
            strictEqual(execError.status ?? null, exitCase.expectedExitCode, `${run.label} ${exitCase.name} exit code mismatch stdout=${execError.stdout ?? ""} stderr=${execError.stderr ?? ""}`);
            process.stdout.write(`std-sys ${exitCase.name} ${run.label} ok\n`);
        }
    } catch (error) {
        if (error instanceof Error && error.message.includes("unexpectedly completed successfully")) {
            throw error;
        }
        throw error;
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
}

const successCases: readonly SuccessCase[] = [
    {
        name: "open-read",
        fileName: "test~std~sys~open_read@main.iw",
        entry: "test~std~sys~open_read@main",
        expectedLines: ["101"],
        prepare: (): void => {
            prepareArtifactDir();
            writeFileSync(inputPath, inputText, "utf8");
        },
        verify: (): void => {
            strictEqual(readFileSync(inputPath, "utf8"), inputText);
        }
    },
    {
        name: "open-write",
        fileName: "test~std~sys~open_write@main.iw",
        entry: "test~std~sys~open_write@main",
        expectedLines: ["111"],
        prepare: (): void => {
            prepareArtifactDir();
            writeFileSync(openWritePath, staleText, "utf8");
        },
        verify: (): void => {
            strictEqual(readFileSync(openWritePath, "utf8"), "");
        }
    },
    {
        name: "openat-read",
        fileName: "test~std~sys~openat_read@main.iw",
        entry: "test~std~sys~openat_read@main",
        expectedLines: ["202"],
        prepare: (): void => {
            prepareArtifactDir();
            writeFileSync(openAtInputPath, openAtInputText, "utf8");
        },
        verify: (): void => {
            strictEqual(readFileSync(openAtInputPath, "utf8"), openAtInputText);
        }
    },
    {
        name: "openat-write",
        fileName: "test~std~sys~openat_write@main.iw",
        entry: "test~std~sys~openat_write@main",
        expectedLines: ["212"],
        prepare: (): void => {
            prepareArtifactDir();
            writeFileSync(openAtWritePath, staleText, "utf8");
        },
        verify: (): void => {
            strictEqual(readFileSync(openAtWritePath, "utf8"), openAtWriteText);
        }
    },
    {
        name: "creat",
        fileName: "test~std~sys~creat@main.iw",
        entry: "test~std~sys~creat@main",
        expectedLines: ["222"],
        prepare: (): void => {
            prepareArtifactDir();
            writeFileSync(creatPath, staleText, "utf8");
        },
        verify: (): void => {
            strictEqual(readFileSync(creatPath, "utf8"), creatText);
        }
    },
    {
        name: "pread",
        fileName: "test~std~sys~pread@main.iw",
        entry: "test~std~sys~pread@main",
        expectedLines: ["363"],
        prepare: (): void => {
            prepareArtifactDir();
            writeFileSync(preadPath, preadText, "utf8");
        },
        verify: (): void => {
            strictEqual(readFileSync(preadPath, "utf8"), preadText);
        }
    },
    {
        name: "pwrite",
        fileName: "test~std~sys~pwrite@main.iw",
        entry: "test~std~sys~pwrite@main",
        expectedLines: ["373"],
        prepare: (): void => {
            prepareArtifactDir();
        },
        verify: (): void => {
            strictEqual(readFileSync(pwritePath, "utf8"), pwriteSparseText);
        }
    },
    {
        name: "seek",
        fileName: "test~std~sys~seek@main.iw",
        entry: "test~std~sys~seek@main",
        expectedLines: ["306"],
        prepare: (): void => {
            prepareArtifactDir();
            writeFileSync(seekPath, seekText, "utf8");
        },
        verify: (): void => {
            strictEqual(readFileSync(seekPath, "utf8"), seekText);
        }
    },
    {
        name: "close",
        fileName: "test~std~sys~close@main.iw",
        entry: "test~std~sys~close@main",
        expectedLines: ["121"],
        prepare: (): void => {
            prepareArtifactDir();
        },
        verify: (): void => {
            ok(existsSync(artifactDir));
        }
    },
    {
        name: "read",
        fileName: "test~std~sys~read@main.iw",
        entry: "test~std~sys~read@main",
        expectedLines: ["131"],
        prepare: (): void => {
            prepareArtifactDir();
            writeFileSync(inputPath, inputText, "utf8");
        },
        verify: (): void => {
            strictEqual(readFileSync(inputPath, "utf8"), inputText);
        }
    },
    {
        name: "write",
        fileName: "test~std~sys~write@main.iw",
        entry: "test~std~sys~write@main",
        expectedLines: ["141"],
        prepare: (): void => {
            prepareArtifactDir();
        },
        verify: (): void => {
            strictEqual(readFileSync(writePath, "utf8"), writeText);
        }
    },
    {
        name: "pipe2",
        fileName: "test~std~sys~pipe2@main.iw",
        entry: "test~std~sys~pipe2@main",
        expectedLines: ["152"],
        prepare: (): void => {
            prepareArtifactDir();
        },
        verify: (): void => {
            ok(existsSync(artifactDir));
        }
    },
    {
        name: "dup2",
        fileName: "test~std~sys~dup2@main.iw",
        entry: "test~std~sys~dup2@main",
        expectedLines: ["163"],
        prepare: (): void => {
            prepareArtifactDir();
        },
        verify: (): void => {
            ok(existsSync(artifactDir));
        }
    },
    {
        name: "dup",
        fileName: "test~std~sys~dup@main.iw",
        entry: "test~std~sys~dup@main",
        expectedLines: ["233"],
        prepare: (): void => {
            prepareArtifactDir();
        },
        verify: (): void => {
            ok(existsSync(artifactDir));
        }
    },
    {
        name: "dup3",
        fileName: "test~std~sys~dup3@main.iw",
        entry: "test~std~sys~dup3@main",
        expectedLines: ["243"],
        prepare: (): void => {
            prepareArtifactDir();
        },
        verify: (): void => {
            ok(existsSync(artifactDir));
        }
    },
    {
        name: "fcntl",
        fileName: "test~std~sys~fcntl@main.iw",
        entry: "test~std~sys~fcntl@main",
        expectedLines: ["252"],
        prepare: (): void => {
            prepareArtifactDir();
        },
        verify: (): void => {
            ok(existsSync(artifactDir));
        }
    },
    {
        name: "socketpair-stream",
        fileName: "test~std~sys~socketpair_stream@main.iw",
        entry: "test~std~sys~socketpair_stream@main",
        expectedLines: ["424"],
        prepare: (): void => {
            prepareArtifactDir();
        },
        verify: (): void => {
            ok(existsSync(artifactDir));
        }
    },
    {
        name: "poll-socketpair",
        fileName: "test~std~sys~poll_socketpair@main.iw",
        entry: "test~std~sys~poll_socketpair@main",
        expectedLines: ["616"],
        prepare: (): void => {
            prepareArtifactDir();
        },
        verify: (): void => {
            ok(existsSync(artifactDir));
        }
    },
    {
        name: "ppoll-socketpair",
        fileName: "test~std~sys~ppoll_socketpair@main.iw",
        entry: "test~std~sys~ppoll_socketpair@main",
        expectedLines: ["626"],
        prepare: (): void => {
            prepareArtifactDir();
        },
        verify: (): void => {
            ok(existsSync(artifactDir));
        }
    },
    {
        name: "timerfd-epoll",
        fileName: "test~std~sys~timerfd_epoll@main.iw",
        entry: "test~std~sys~timerfd_epoll@main",
        expectedLines: ["535"],
        prepare: (): void => {
            prepareArtifactDir();
        },
        verify: (): void => {
            ok(existsSync(artifactDir));
        }
    },
    {
        name: "eventfd-epoll-pwait",
        fileName: "test~std~sys~eventfd_epoll_pwait@main.iw",
        entry: "test~std~sys~eventfd_epoll_pwait@main",
        expectedLines: ["555"],
        prepare: (): void => {
            prepareArtifactDir();
        },
        verify: (): void => {
            ok(existsSync(artifactDir));
        }
    },
    {
        name: "sendfile-socketpair",
        fileName: "test~std~sys~sendfile_socketpair@main.iw",
        entry: "test~std~sys~sendfile_socketpair@main",
        expectedLines: ["563"],
        prepare: (): void => {
            prepareArtifactDir();
            writeFileSync(sendfilePath, sendfileText, "utf8");
        },
        verify: (): void => {
            strictEqual(readFileSync(sendfilePath, "utf8"), sendfileText);
        }
    },
    {
        name: "readv-writev-socketpair",
        fileName: "test~std~sys~readv_writev_socketpair@main.iw",
        entry: "test~std~sys~readv_writev_socketpair@main",
        expectedLines: ["575"],
        prepare: (): void => {
            prepareArtifactDir();
        },
        verify: (): void => {
            ok(existsSync(artifactDir));
        }
    },
    {
        name: "sendmsg-recvmsg-socketpair",
        fileName: "test~std~sys~sendmsg_recvmsg_socketpair@main.iw",
        entry: "test~std~sys~sendmsg_recvmsg_socketpair@main",
        expectedLines: ["641"],
        prepare: (): void => {
            prepareArtifactDir();
        },
        verify: (): void => {
            ok(existsSync(artifactDir));
        }
    },
    {
        name: "fsync",
        fileName: "test~std~sys~fsync@main.iw",
        entry: "test~std~sys~fsync@main",
        expectedLines: ["262"],
        prepare: (): void => {
            prepareArtifactDir();
            writeFileSync(fsyncPath, staleText, "utf8");
        },
        verify: (): void => {
            strictEqual(readFileSync(fsyncPath, "utf8"), fsyncText);
        }
    },
    {
        name: "fdatasync",
        fileName: "test~std~sys~fdatasync@main.iw",
        entry: "test~std~sys~fdatasync@main",
        expectedLines: ["272"],
        prepare: (): void => {
            prepareArtifactDir();
            writeFileSync(fdatasyncPath, staleText, "utf8");
        },
        verify: (): void => {
            strictEqual(readFileSync(fdatasyncPath, "utf8"), fdatasyncText);
        }
    },
    {
        name: "fstat",
        fileName: "test~std~sys~fstat@main.iw",
        entry: "test~std~sys~fstat@main",
        expectedLines: ["316"],
        prepare: (): void => {
            prepareArtifactDir();
            writeFileSync(fstatPath, fstatText, "utf8");
        },
        verify: (): void => {
            strictEqual(readFileSync(fstatPath, "utf8"), fstatText);
        }
    },
    {
        name: "mkdir",
        fileName: "test~std~sys~mkdir@main.iw",
        entry: "test~std~sys~mkdir@main",
        expectedLines: ["321"],
        prepare: (): void => {
            prepareArtifactDir();
        },
        verify: (): void => {
            ok(existsSync(mkdirPath));
        }
    },
    {
        name: "rmdir",
        fileName: "test~std~sys~rmdir@main.iw",
        entry: "test~std~sys~rmdir@main",
        expectedLines: ["330"],
        prepare: (): void => {
            prepareArtifactDir();
            mkdirSync(rmdirPath);
        },
        verify: (): void => {
            ok(!existsSync(rmdirPath));
        }
    },
    {
        name: "unlink",
        fileName: "test~std~sys~unlink@main.iw",
        entry: "test~std~sys~unlink@main",
        expectedLines: ["340"],
        prepare: (): void => {
            prepareArtifactDir();
            writeFileSync(unlinkPath, staleText, "utf8");
        },
        verify: (): void => {
            ok(!existsSync(unlinkPath));
        }
    },
    {
        name: "rename",
        fileName: "test~std~sys~rename@main.iw",
        entry: "test~std~sys~rename@main",
        expectedLines: ["351"],
        prepare: (): void => {
            prepareArtifactDir();
            writeFileSync(renameSourcePath, writeText, "utf8");
        },
        verify: (): void => {
            ok(!existsSync(renameSourcePath));
            strictEqual(readFileSync(renameTargetPath, "utf8"), writeText);
        }
    },
    {
        name: "cwd-chdir",
        fileName: "test~std~sys~cwd_chdir@main.iw",
        entry: "test~std~sys~cwd_chdir@main",
        expectedLines: ["704"],
        prepare: (): void => {
            prepareArtifactDir();
            mkdirSync(cwdTargetDirPath, { recursive: true });
            writeFileSync(cwdTargetFilePath, cwdTargetText, "utf8");
        },
        verify: (): void => {
            strictEqual(readFileSync(cwdTargetFilePath, "utf8"), cwdTargetText);
        }
    },
];

const exitCases: readonly ExitCase[] = [
    {
        name: "exit",
        fileName: "test~std~sys~exit@main.iw",
        entry: "test~std~sys~exit@main",
        expectedExitCode: 41
    },
    {
        name: "exit-group",
        fileName: "test~std~sys~exit_group@main.iw",
        entry: "test~std~sys~exit_group@main",
        expectedExitCode: 42
    }
];

prepareArtifactDir();
execBuildJsonCliSync(cliPath, ["check", fixtureDir], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER_BYTES,
    timeout: TEST_TIMEOUT_MS
});

for (const successCase of successCases) {
    for (const run of successRuns) {
        runSuccessCase(successCase, run);
    }
}

for (const exitCase of exitCases) {
    for (const run of exitRuns) {
        runExitCase(exitCase, run);
    }
}
