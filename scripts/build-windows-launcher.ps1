$ErrorActionPreference = 'Stop'

$compilerCandidates = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$compiler = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ($null -eq $compiler) {
  throw 'Microsoft .NET Framework C# compiler was not found; install the Windows .NET Framework developer tools.'
}

$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'native\windows-launcher\Program.cs'
$outputDirectory = Join-Path $root 'bin\win32-x64'
$output = Join-Path $outputDirectory 'agy-launcher.exe'
$outputTemp = Join-Path $outputDirectory "agy-launcher.$PID.tmp.exe"
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
& $compiler /nologo /target:winexe /platform:x64 /optimize+ "/out:$outputTemp" $source
if ($LASTEXITCODE -ne 0) { throw "C# launcher compilation failed with exit code $LASTEXITCODE" }

if (Test-Path -LiteralPath $output) {
  $outputOld = Join-Path $outputDirectory "agy-launcher.old.$PID.exe"
  Move-Item -LiteralPath $output -Destination $outputOld -Force
}
Move-Item -LiteralPath $outputTemp -Destination $output -Force

Get-ChildItem -Path $outputDirectory -Filter 'agy-launcher.*.exe' | ForEach-Object {
  try { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop } catch {}
}

Write-Output "Built $output"
