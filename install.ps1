param(
  [string]$BrowserPath,
  [switch]$DownloadChromeForTesting,
  [switch]$NoLaunch,
  [switch]$DesktopShortcut,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSCommandPath
$extension = Join-Path $root "extension"
$manifest = Join-Path $extension "manifest.json"
$profileDir = Join-Path $root ".profile"
$launcher = Join-Path $root "LocaCloak-plus.cmd"
$shortcut = Join-Path $root "LocaCloak-plus.lnk"
$desktopShortcutPath = Join-Path ([Environment]::GetFolderPath("Desktop")) "LocaCloak-plus.lnk"

function Write-Step([string]$message) {
  Write-Host "[LocaCloak-plus] $message"
}

function Test-UsableBrowser([string]$path) {
  if (-not $path -or -not (Test-Path $path)) { return $false }
  $versionInfo = (Get-Item $path).VersionInfo
  if ($versionInfo.ProductName -eq "Google Chrome" -and $path -notmatch "Chrome for Testing") {
    return $false
  }
  return $true
}

function Find-Browser {
  $candidates = @()
  if ($BrowserPath) { $candidates += $BrowserPath }
  if ($env:LOCACLOAK_CHROME) { $candidates += $env:LOCACLOAK_CHROME }
  $candidates += (Join-Path $root "tools\chrome-for-testing\chrome-win64\chrome.exe")

  Get-ChildItem (Join-Path $env:LOCALAPPDATA "ms-playwright") -Directory -Filter "chromium-*" -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    ForEach-Object { $candidates += (Join-Path $_.FullName "chrome-win64\chrome.exe") }

  Get-ChildItem (Join-Path $root ".browsers") -Directory -Filter "chrome-*" -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    ForEach-Object { $candidates += (Join-Path $_.FullName "chrome-win64\chrome.exe") }

  $candidates += "C:\Program Files\Chromium\Application\chrome.exe"
  $candidates += "C:\Program Files\Google\Chrome\Application\chrome.exe"

  foreach ($candidate in $candidates) {
    if (Test-UsableBrowser $candidate) { return (Resolve-Path $candidate).Path }
  }
  return $null
}

function Install-ChromeForTesting {
  $destination = Join-Path $root "tools\chrome-for-testing"
  $zip = Join-Path $root "tools\chrome-for-testing.zip"
  New-Item -ItemType Directory -Force -Path (Join-Path $root "tools") | Out-Null
  Write-Step "Downloading Chrome for Testing..."
  $versions = Invoke-RestMethod "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json"
  $download = $versions.channels.Stable.downloads.chrome | Where-Object { $_.platform -eq "win64" } | Select-Object -First 1
  if (-not $download) { throw "Could not find a win64 Chrome for Testing download." }
  Invoke-WebRequest -Uri $download.url -OutFile $zip
  if (Test-Path $destination) { Remove-Item $destination -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $destination | Out-Null
  Expand-Archive -Path $zip -DestinationPath $destination -Force
  Remove-Item $zip -Force
  return (Join-Path $destination "chrome-win64\chrome.exe")
}

if ($Uninstall) {
  foreach ($path in @($launcher, $shortcut, $desktopShortcutPath)) {
    if (Test-Path $path) { Remove-Item $path -Force; Write-Step "Removed $path" }
  }
  if (Test-Path $profileDir) { Remove-Item $profileDir -Recurse -Force; Write-Step "Removed $profileDir" }
  Write-Step "Uninstalled. The extension source folder was left untouched."
  return
}

if (-not (Test-Path $manifest)) {
  throw "Extension manifest not found: $manifest"
}
$manifestData = Get-Content $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
Write-Step "Preparing LocaCloak-plus $($manifestData.version) from $extension"

$browser = Find-Browser
if (-not $browser -and $DownloadChromeForTesting) {
  $browser = Install-ChromeForTesting
}
if (-not $browser) {
  Write-Host ""
  Write-Host "No Chromium/Chrome for Testing binary that supports --load-extension was found." -ForegroundColor Yellow
  Write-Host "Google Chrome 137+ ignores --load-extension in branded builds." -ForegroundColor Yellow
  Write-Host "Options:" -ForegroundColor Yellow
  Write-Host "  1. Run: .\install.ps1 -DownloadChromeForTesting"
  Write-Host "  2. Or open chrome://extensions -> Developer mode -> Load unpacked -> select:"
  Write-Host "     $extension"
  exit 1
}

New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
$launcherContent = @"
@echo off
setlocal
start "" "$browser" --user-data-dir="$profileDir" --load-extension="$extension" --no-first-run --no-default-browser-check --new-window "chrome://extensions/"
endlocal
"@
Set-Content -Path $launcher -Value $launcherContent -Encoding ASCII

$wsh = New-Object -ComObject WScript.Shell
$shellShortcut = $wsh.CreateShortcut($shortcut)
$shellShortcut.TargetPath = $browser
$shellShortcut.Arguments = "--user-data-dir=`"$profileDir`" --load-extension=`"$extension`" --no-first-run --no-default-browser-check --new-window `"chrome://extensions/`""
$shellShortcut.WorkingDirectory = $root
$shellShortcut.IconLocation = "$browser,0"
$shellShortcut.Save()

if ($DesktopShortcut) {
  $desktop = $wsh.CreateShortcut($desktopShortcutPath)
  $desktop.TargetPath = $browser
  $desktop.Arguments = $shellShortcut.Arguments
  $desktop.WorkingDirectory = $root
  $desktop.IconLocation = "$browser,0"
  $desktop.Save()
}

Write-Step "Browser:  $browser"
Write-Step "Profile:  $profileDir"
Write-Step "Launcher: $launcher"
if ($DesktopShortcut) { Write-Step "Desktop:  $desktopShortcutPath" }
Write-Step "Done. Double-click LocaCloak-plus.cmd (or LocaCloak-plus.lnk) to start with the extension loaded."
Write-Step "This is a dedicated Chromium profile; your daily Chrome profile is not modified."
Write-Step "For daily Chrome, use chrome://extensions -> Load unpacked -> $extension (manual, because Chrome 137+ blocks --load-extension)."

if (-not $NoLaunch) {
  $arguments = "--user-data-dir=`"$profileDir`" --load-extension=`"$extension`" --no-first-run --no-default-browser-check --new-window `"chrome://extensions/`""
  Start-Process -FilePath $browser -ArgumentList $arguments
}
