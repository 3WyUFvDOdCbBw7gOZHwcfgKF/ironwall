Param(
    [switch]$Clean
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$releaseRoot = $PSScriptRoot
$examplesRoot = Join-Path $releaseRoot "examples"
$buildRoot = Join-Path $examplesRoot "build"
$cliPath = Join-Path $releaseRoot "ironwall.exe"
$buildTimeoutMs = 120000
$raytracerSimpleTimeoutMs = 8000
$raytracerSimpleMaxPrivateBytes = 256MB

function Normalize-Output {
    param([string]$Value)

    return (($Value -replace "`r", "") -split "`n" | Where-Object { $_.Trim().Length -gt 0 }) -join "`n"
}

function ConvertTo-ProcessArgumentString {
    param([string[]]$Arguments)

    return ($Arguments | ForEach-Object {
        if ($_ -match '^[A-Za-z0-9_./:@=+\-\\]+$') {
            $_
        } else {
            '"' + ($_ -replace '"', '\"') + '"'
        }
    }) -join " "
}

function Invoke-ProcessWithTimeout {
    param(
        [string]$Label,
        [string]$Command,
        [string[]]$Arguments,
        [int]$TimeoutMs,
        [string]$WorkingDirectory
    )

    $stdoutPath = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString() + ".stdout.txt")
    $stderrPath = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString() + ".stderr.txt")
    try {
        $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = $Command
        $startInfo.Arguments = ConvertTo-ProcessArgumentString $Arguments
        $startInfo.WorkingDirectory = $WorkingDirectory
        $startInfo.UseShellExecute = $false
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $process = [System.Diagnostics.Process]::Start($startInfo)
        if (-not $process.WaitForExit($TimeoutMs)) {
            $process.Kill($true)
            throw "$Label timed out after ${TimeoutMs}ms"
        }
        $process.WaitForExit()
        $stdout = $process.StandardOutput.ReadToEnd()
        $stderr = $process.StandardError.ReadToEnd()
        return [PSCustomObject]@{
            ExitCode = $process.ExitCode
            Stdout = $stdout
            Stderr = $stderr
        }
    } finally {
        Remove-Item $stdoutPath -Force -ErrorAction SilentlyContinue
        Remove-Item $stderrPath -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-ReleaseBuild {
    param(
        [string]$Label,
        [string]$ExpectedToken,
        [string]$ConfigPath
    )

    $buildRun = Invoke-ProcessWithTimeout $Label $cliPath @($ConfigPath) $buildTimeoutMs $releaseRoot
    $output = $buildRun.Stdout + $buildRun.Stderr
    if ($buildRun.ExitCode -ne 0) {
        throw "$Label failed`n$output"
    }
    if ($output.Contains("ExperimentalWarning") -or $output.Contains("warning:")) {
        throw "$Label emitted warnings`n$output"
    }
    if (-not $output.Contains($ExpectedToken)) {
        throw "$Label build output mismatch`n$output"
    }
}

function Invoke-LimitedProcess {
    param(
        [string]$Label,
        [string]$Command,
        [string[]]$Arguments,
        [string]$WorkingDirectory,
        [int]$TimeoutMs,
        [UInt64]$MaxPrivateBytes
    )

    $stdoutPath = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString() + ".stdout.txt")
    $stderrPath = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString() + ".stderr.txt")
    try {
        $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = $Command
        $startInfo.Arguments = ConvertTo-ProcessArgumentString $Arguments
        $startInfo.WorkingDirectory = $WorkingDirectory
        $startInfo.UseShellExecute = $false
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $process = [System.Diagnostics.Process]::Start($startInfo)
        $start = [System.Diagnostics.Stopwatch]::StartNew()
        while (-not $process.HasExited) {
            if ($start.ElapsedMilliseconds -gt $TimeoutMs) {
                $process.Kill($true)
                throw "$Label timed out after ${TimeoutMs}ms"
            }
            $process.Refresh()
            if ([UInt64]$process.PrivateMemorySize64 -gt $MaxPrivateBytes) {
                $process.Kill($true)
                throw "$Label exceeded private memory limit ${MaxPrivateBytes} bytes"
            }
            Start-Sleep -Milliseconds 25
        }
        $process.WaitForExit()
        $stdout = $process.StandardOutput.ReadToEnd()
        $stderr = $process.StandardError.ReadToEnd()
        return [PSCustomObject]@{
            ExitCode = $process.ExitCode
            Stdout = $stdout
            Stderr = $stderr
        }
    } finally {
        Remove-Item $stdoutPath -Force -ErrorAction SilentlyContinue
        Remove-Item $stderrPath -Force -ErrorAction SilentlyContinue
    }
}

function Assert-CommandExitCode {
    param(
        [string]$Label,
        [string]$Command,
        [string[]]$Arguments,
        [int]$ExpectedExitCode
    )

    $outputLines = & $Command @Arguments 2>&1
    $status = $LASTEXITCODE
    $output = $outputLines | Out-String
    if ($status -ne $ExpectedExitCode) {
        throw "$Label exit code mismatch: expected $ExpectedExitCode got $status`n$output"
    }
    if ((Normalize-Output $output).Length -ne 0) {
        throw "$Label output mismatch`n$output"
    }
}

if ($Clean) {
    if (Test-Path $buildRoot) {
        Remove-Item $buildRoot -Recurse -Force
    }
    Write-Output "clean ok"
    exit 0
}

if (-not (Test-Path $cliPath)) {
    throw "missing release standalone executable: $cliPath"
}

New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null

Invoke-ReleaseBuild "hello-argv" "Built executable:" (Join-Path $examplesRoot "hello-argv\build-iw.json")
Assert-CommandExitCode "hello-argv" (Join-Path $buildRoot "hello-argv.exe") @("a", "bb", "ccc") 123
Write-Output "hello-argv ok"

Invoke-ReleaseBuild "module-global-state" "Built executable:" (Join-Path $examplesRoot "module-global-state\build-iw.json")
Assert-CommandExitCode "module-global-state" (Join-Path $buildRoot "module-global-state.exe") @() 100
Write-Output "module-global-state ok"

& (Join-Path $examplesRoot "ffi-static-lib\native\build-native.ps1")
if ($LASTEXITCODE -ne 0) {
    throw "ffi-static-lib native helper failed"
}
Invoke-ReleaseBuild "ffi-static-lib" "Built executable:" (Join-Path $examplesRoot "ffi-static-lib\build-iw.json")
Assert-CommandExitCode "ffi-static-lib" (Join-Path $buildRoot "ffi-static-lib.exe") @() -31
Write-Output "ffi-static-lib ok"

Invoke-ReleaseBuild "precompiled-lib" "Packed lib:" (Join-Path $examplesRoot "precompiled-lib\lib\build-iw.json")
Invoke-ReleaseBuild "precompiled-app" "Built executable:" (Join-Path $examplesRoot "precompiled-lib\app\build-iw.json")
Assert-CommandExitCode "precompiled-app" (Join-Path $buildRoot "precompiled-app.exe") @() 15
Write-Output "precompiled-lib ok"

Invoke-ReleaseBuild "fft-bigint" "Built executable:" (Join-Path $examplesRoot "fft-bigint\build-iw.json")
$fftOutputLines = & (Join-Path $buildRoot "fft-bigint.exe") 2>&1
$fftStatus = $LASTEXITCODE
$fftOutput = $fftOutputLines | Out-String
if ($fftStatus -ne 0) {
    throw "fft-bigint failed`n$fftOutput"
}
$fftExpected = @(
    "fft_0008_ok",
    "fft_0016_ok",
    "fft_0032_ok",
    "fft_0064_ok",
    "fft_f6_0064_ok",
    "fft_f7_0065_ok"
) -join "`n"
if ((Normalize-Output $fftOutput) -ne $fftExpected) {
    throw "fft-bigint output mismatch`n$fftOutput"
}
Write-Output "fft-bigint ok"

Invoke-ReleaseBuild "raytracer-simple" "Built executable:" (Join-Path $examplesRoot "raytracer-simple\build-iw.json")
$raytracerOutputPath = Join-Path $buildRoot "raytracer-simple-validation.ppm"
Push-Location $examplesRoot
try {
    $raytracerRun = Invoke-LimitedProcess "raytracer-simple" (Join-Path $buildRoot "raytracer-simple.exe") @("build\raytracer-simple-validation.ppm", "24", "18") $examplesRoot $raytracerSimpleTimeoutMs $raytracerSimpleMaxPrivateBytes
} finally {
    Pop-Location
}
if ($raytracerRun.ExitCode -ne 0) {
    throw "raytracer-simple failed`n$($raytracerRun.Stdout)$($raytracerRun.Stderr)"
}
if ((Normalize-Output ($raytracerRun.Stdout + $raytracerRun.Stderr)).Length -ne 0) {
    throw "raytracer-simple output mismatch`n$($raytracerRun.Stdout)$($raytracerRun.Stderr)"
}
if (-not (Test-Path $raytracerOutputPath)) {
    throw "raytracer-simple did not produce output image"
}
$firstLine = (Get-Content $raytracerOutputPath -TotalCount 1)
if ($firstLine -ne "P3") {
    throw "raytracer-simple ppm header mismatch: $firstLine"
}
Write-Output "raytracer-simple ok"
