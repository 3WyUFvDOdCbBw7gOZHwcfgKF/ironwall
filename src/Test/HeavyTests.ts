export const heavyTestFileNames: ReadonlySet<string> = new Set<string>([
    "app-http-loopback.test.js",
    "backend-timing-compare.test.js",
    "closure-hof-stress.test.js",
    "fft-bigint-memory.test.js",
    "gc-multithread-stw.test.js",
    "generic-stress.test.js",
    "raytracer-memory.test.js",
    "std-memory-risk.test.js",
    "std-sys-policy.test.js",
    "std-sys-windows.test.js",
    "std-sys-windows-abort.test.js",
    "std-thread-policy.test.js",
    "x64-gc-multithread-stw.test.js"
]);

export function shouldRunHeavyTests(): boolean {
    return process.env.IW_TEST_HEAVY === "1" || process.env.IW_TEST_HEAVY === "true";
}
