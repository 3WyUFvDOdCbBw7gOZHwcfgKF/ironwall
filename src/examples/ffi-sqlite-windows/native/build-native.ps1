Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptRoot = $PSScriptRoot
$exampleRoot = (Resolve-Path (Join-Path $scriptRoot "..")).Path
$nativeRoot = Join-Path $exampleRoot "native"
$clang = if ($env:CC) { $env:CC } else { "clang-cl" }
$libExe = if ($env:AR) { $env:AR } else { "lib" }

New-Item -ItemType Directory -Force -Path $nativeRoot | Out-Null

$sourcePath = Join-Path $nativeRoot "sqlite-self-check.c"
$objectPath = Join-Path $nativeRoot "sqlite-self-check.obj"
$wrapperLibPath = Join-Path $nativeRoot "sqlite_ffi_example.lib"

& $clang "/nologo" "/O2" "/std:c11" "/c" $sourcePath "/Fo$objectPath"
if ($LASTEXITCODE -ne 0) {
    throw "clang-cl failed for sqlite-self-check.c"
}

& $libExe "/nologo" "/out:$wrapperLibPath" $objectPath
if ($LASTEXITCODE -ne 0) {
    throw "lib failed for sqlite_ffi_example.lib"
}
