Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptRoot = $PSScriptRoot
$exampleRoot = (Resolve-Path (Join-Path $scriptRoot "..")).Path
$examplesRoot = (Resolve-Path (Join-Path $scriptRoot "..\..")).Path
$nativeBuildRoot = Join-Path $examplesRoot "build\native"
$clang = if ($env:CC) { $env:CC } else { "clang-cl" }
$libExe = if ($env:AR) { $env:AR } else { "lib" }

New-Item -ItemType Directory -Force -Path $nativeBuildRoot | Out-Null

$sourcePath = Join-Path $scriptRoot "sqlite-self-check.c"
$objectPath = Join-Path $nativeBuildRoot "sqlite-self-check.obj"
$wrapperLibPath = Join-Path $nativeBuildRoot "sqlite_ffi_example.lib"

& $clang "/nologo" "/O2" "/std:c11" "/c" $sourcePath "/Fo$objectPath"
if ($LASTEXITCODE -ne 0) {
    throw "clang-cl failed for sqlite-self-check.c"
}

& $libExe "/nologo" "/out:$wrapperLibPath" $objectPath
if ($LASTEXITCODE -ne 0) {
    throw "lib failed for sqlite_ffi_example.lib"
}
