Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptRoot = $PSScriptRoot
$examplesRoot = (Resolve-Path (Join-Path $scriptRoot "..\..")).Path
$releaseRoot = (Resolve-Path (Join-Path $scriptRoot "..\..\..")).Path
$buildRoot = Join-Path $examplesRoot "build\native"
$includeDir = Join-Path $releaseRoot "cheader"
$clang = if ($env:CC) { $env:CC } else { "clang-cl" }
$libExe = if ($env:AR) { $env:AR } else { "lib" }

New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null

$sumSrc = Join-Path $scriptRoot "ffi_sum4.c"
$negateSrc = Join-Path $scriptRoot "ffi_negate.c"
$sumObj = Join-Path $buildRoot "ffi_sum4.obj"
$negateObj = Join-Path $buildRoot "ffi_negate.obj"
$libPath = Join-Path $buildRoot "libffi_example.lib"

& $clang "/nologo" "/O2" "/std:c11" "/I$includeDir" "/c" $sumSrc "/Fo$sumObj"
if ($LASTEXITCODE -ne 0) {
    throw "clang-cl failed for ffi_sum4.c"
}

& $clang "/nologo" "/O2" "/std:c11" "/I$includeDir" "/c" $negateSrc "/Fo$negateObj"
if ($LASTEXITCODE -ne 0) {
    throw "clang-cl failed for ffi_negate.c"
}

& $libExe "/nologo" "/out:$libPath" $sumObj $negateObj
if ($LASTEXITCODE -ne 0) {
    throw "lib failed for libffi_example.lib"
}