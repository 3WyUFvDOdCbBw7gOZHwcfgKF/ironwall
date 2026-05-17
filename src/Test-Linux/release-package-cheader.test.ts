import { ok } from "assert";
import { readFileSync } from "fs";
import { join, resolve } from "path";

const repoRoot = resolve(__dirname, "..", "..");
const releaseHeaderLinuxPath = join(repoRoot, "release-package-linux", "cheader", "iw_export_abi.h");
const releaseHeaderWindowsPath = join(repoRoot, "release-package-windows", "cheader", "iw_export_abi.h");
const linuxBackendPath = join(repoRoot, "src", "backend-linux", "Backend-Linux-C.ts");
const linuxBuiltinBackendPath = join(repoRoot, "src", "backend-linux", "Backend-Linux-C-Builtins.ts");
const linuxHostInteropBackendPath = join(repoRoot, "src", "backend-linux", "Backend-Linux-C-HostInterop.ts");
const windowsBackendPath = join(repoRoot, "src", "backend-windows", "Backend-Windows-C.ts");
const windowsBuiltinBackendPath = join(repoRoot, "src", "backend-windows", "Backend-Windows-C-Builtins.ts");
const windowsHostInteropBackendPath = join(repoRoot, "src", "backend-windows", "Backend-Windows-C-HostInterop.ts");

const releaseHeaderLinux = readFileSync(releaseHeaderLinuxPath, "utf8");
const releaseHeaderWindows = readFileSync(releaseHeaderWindowsPath, "utf8");
const linuxBackendSource = [linuxBackendPath, linuxBuiltinBackendPath, linuxHostInteropBackendPath].map((filePath) => readFileSync(filePath, "utf8")).join("\n");
const windowsBackendSource = [windowsBackendPath, windowsBuiltinBackendPath, windowsHostInteropBackendPath].map((filePath) => readFileSync(filePath, "utf8")).join("\n");

const canonicalArrayI5HostDecl = "typedef struct iw_host_array_i5_t { int64_t length; int32_t *items; } iw_host_array_i5_t;";

ok(releaseHeaderLinux.includes("int32_t *items;"), "release-package linux cheader must expose <array i5> items as int32_t*");
ok(!releaseHeaderLinux.includes("int64_t *items;"), "release-package linux cheader must not expose <array i5> items as int64_t*");
ok(releaseHeaderWindows.includes("int32_t *items;"), "release-package windows cheader must expose <array i5> items as int32_t*");
ok(!releaseHeaderWindows.includes("int64_t *items;"), "release-package windows cheader must not expose <array i5> items as int64_t*");
ok(linuxBackendSource.includes(canonicalArrayI5HostDecl), "linux backend exported IW header/runtime must keep <array i5> host items at int32_t*");
ok(windowsBackendSource.includes(canonicalArrayI5HostDecl), "windows backend exported IW header/runtime must keep <array i5> host items at int32_t*");
ok(linuxBackendSource.includes('return "int32_t";'), "linux backend must keep 32-bit host mapping fragments for i5");
ok(windowsBackendSource.includes('return "int32_t";'), "windows backend must keep 32-bit host mapping fragments for i5");
ok(linuxBackendSource.includes('return "uint32_t";'), "linux backend must keep 32-bit host mapping fragments for u5");
ok(windowsBackendSource.includes('return "uint32_t";'), "windows backend must keep 32-bit host mapping fragments for u5");
ok(linuxBackendSource.includes('return "float";'), "linux backend must keep float host mapping fragments for f5");
ok(windowsBackendSource.includes('return "float";'), "windows backend must keep float host mapping fragments for f5");
ok(linuxBackendSource.includes('return "double";'), "linux backend must keep double host mapping fragments for f6");
ok(windowsBackendSource.includes('return "double";'), "windows backend must keep double host mapping fragments for f6");
ok(linuxBackendSource.includes('return "long double";'), "linux backend must keep long double host mapping fragments for f7");
ok(windowsBackendSource.includes('return "long double";'), "windows backend must keep long double host mapping fragments for f7");

process.stdout.write("release-package-cheader ok\n");
