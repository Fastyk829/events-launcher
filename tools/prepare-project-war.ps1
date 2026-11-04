#requires -version 5.1
[CmdletBinding(DefaultParameterSetName = 'FromFolder')]
param(
  [Parameter(Mandatory = $true, ParameterSetName = 'FromFolder')]
  [string] $SourceFolder,

  [Parameter(Mandatory = $true, ParameterSetName = 'FromZip')]
  [string] $ZipPath,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$')]
  [string] $Version,

  [string] $YandexUrl = '',
  [string] $GoogleDriveUrl = '',
  [string[]] $ForceConfigFiles = @(),
  [string] $OutputDirectory = '',
  [switch] $Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$allowedRoots = @(
  'mods', 'config', 'defaultconfigs', 'resourcepacks',
  'shaderpacks', 'kubejs', 'scripts', 'datapacks'
)
$limit = 12GB
$maxFiles = 30000

function Assert-PublicUrl([string] $value, [string] $provider) {
  if ([string]::IsNullOrWhiteSpace($value)) { return $null }
  try { $uri = [Uri]::new($value) }
  catch { throw "Invalid $provider URL." }
  if ($uri.Scheme -ne 'https' -or $uri.UserInfo -or !$uri.IsDefaultPort) {
    throw "Only public HTTPS $provider links are supported."
  }
  if ($provider -eq 'yandex-disk') {
    if (@('disk.yandex.ru','disk.yandex.com','yadi.sk') -notcontains $uri.Host) {
      throw 'Use a Yandex Disk public file share URL.'
    }
  }
  if ($provider -eq 'google-drive') {
    if ($uri.Host -ne 'drive.google.com' -or
        $uri.AbsolutePath -notmatch '^/file/d/([A-Za-z0-9_-]{10,128})(/|$)') {
      throw 'Use a Google Drive public file link (/file/d/FILE_ID/view).'
    }
  }
  return $uri.AbsoluteUri
}

$yandex = Assert-PublicUrl $YandexUrl 'yandex-disk'
$google = Assert-PublicUrl $GoogleDriveUrl 'google-drive'
if (!$OutputDirectory) {
  $OutputDirectory = Join-Path (Join-Path $PSScriptRoot '..\project-war-release') $Version
}
$destination = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($destination) | Out-Null
$outZip = Join-Path $destination 'project-war.zip'
$outManifest = Join-Path $destination 'project-war.modpack.json'

if ($PSCmdlet.ParameterSetName -eq 'FromFolder') {
  $root = (Resolve-Path -LiteralPath $SourceFolder -ErrorAction Stop).ProviderPath
  $allFiles = New-Object 'System.Collections.Generic.List[object]'
  foreach ($folderName in $allowedRoots) {
    $folderPath = Join-Path $root $folderName
    if (!(Test-Path -LiteralPath $folderPath -PathType Container)) { continue }
    $items = @(Get-ChildItem -LiteralPath $folderPath -Recurse -Force)
    foreach ($item in $items) {
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing symlink/junction in modpack: $($item.FullName)"
      }
      if (!$item.PSIsContainer) {
        $rel = $item.FullName.Substring($root.TrimEnd('\','/').Length).TrimStart('\','/').Replace('\','/')
        $allFiles.Add([pscustomobject]@{ Path = $item.FullName; Relative = $rel; Length = $item.Length })
      }
    }
  }
  $optionsPath = Join-Path $root 'options.txt'
  if (Test-Path -LiteralPath $optionsPath -PathType Leaf) {
    $options = Get-Item -LiteralPath $optionsPath -Force
    if (($options.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Refusing symlink for options.txt'
    }
    $allFiles.Add([pscustomobject]@{
      Path = $options.FullName; Relative = 'options.txt'; Length = $options.Length
    })
  }
  if ($allFiles.Count -gt $maxFiles) { throw 'Too many files (maximum 30000).' }
  if (@($allFiles | Where-Object { $_.Relative -match '^mods/[^/].*\.jar$' }).Count -eq 0) {
    throw 'A Project War modpack must contain at least one mods/*.jar file.'
  }
  $size = 0L
  foreach ($file in $allFiles) { $size += $file.Length }
  if ($size -gt $limit) { throw 'Modpack content exceeds 12 GB.' }
  if ((Test-Path -LiteralPath $outZip) -and !$Force) {
    throw "ZIP already exists at $outZip. Use -Force to replace it."
  }
  if (Test-Path -LiteralPath $outZip) { Remove-Item -LiteralPath $outZip -Force }

  $zip = [IO.Compression.ZipFile]::Open($outZip, [IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($file in $allFiles) {
      [IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $zip, $file.Path, $file.Relative, [IO.Compression.CompressionLevel]::Optimal
      ) | Out-Null
    }
  } finally { $zip.Dispose() }
  Write-Output "Created: $outZip ($($allFiles.Count) files)"
} else {
  $existingZip = (Resolve-Path -LiteralPath $ZipPath -ErrorAction Stop).ProviderPath
  if ($existingZip -ine $outZip) {
    if ((Test-Path -LiteralPath $outZip) -and !$Force) {
      throw "ZIP already exists at $outZip. Use -Force to replace it."
    }
    Copy-Item -LiteralPath $existingZip -Destination $outZip -Force
  }
}

$archive = [IO.Compression.ZipFile]::OpenRead($outZip)
try {
  $count = 0
  $size = 0L
  $hasMods = $false
  $zipNames = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in $archive.Entries) {
    $name = $entry.FullName
    if ($name.Contains('\') -or $name.StartsWith('/') -or
        $name -match '(^|/)\.\.?(/|$)' -or $name -match '(^|/)[^/]*:' -or
        $name.Contains('//') -or $name.Contains([char]0)) {
      throw "Unsafe path in ZIP: $name"
    }
    $pieces = $name.TrimEnd('/').Split('/')
    $isOptions = ($name -ceq 'options.txt')
    if (!$isOptions -and ($allowedRoots -notcontains $pieces[0].ToLowerInvariant() -or
        ($pieces.Length -lt 2 -and !$name.EndsWith('/')))) {
      throw "Disallowed ZIP entry: $name"
    }
    if (!$seen.Add($name)) { throw "Duplicate ZIP path: $name" }
    [void]$zipNames.Add($name)
    if ((($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960) {
      throw "Symlink in ZIP: $name"
    }
    if (!$name.EndsWith('/')) {
      $count++
      $size += $entry.Length
      if ($name -match '^mods/[^/].*\.jar$') { $hasMods = $true }
    }
    if ($count -gt $maxFiles -or $size -gt $limit) {
      throw 'ZIP has too many files or exceeds 12 GB uncompressed.'
    }
  }
  if (!$hasMods) { throw 'ZIP must contain at least one mods/*.jar.' }
  $forcedSeen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  if ($ForceConfigFiles.Count -gt 200) { throw 'Too many forced config files.' }
  foreach ($path in $ForceConfigFiles) {
    if ($path -cnotmatch '^(config|defaultconfigs)/[A-Za-z0-9._+/-]{1,230}$' -or
        $path -match '(^|/)\.\.?(/|$)' -or $path.Contains('//') -or
        $path.EndsWith('/') -or !$forcedSeen.Add($path)) {
      throw "Invalid or repeated config override: $path"
    }
    if (!$zipNames.Contains($path)) { throw "Forced config missing in ZIP: $path" }
  }
} finally { $archive.Dispose() }

$hash = (Get-FileHash -LiteralPath $outZip -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Output "SHA-256: $hash"
Write-Output "ZIP: $outZip"

$sources = @()
if ($yandex) { $sources += @{ provider = 'yandex-disk'; publicUrl = $yandex } }
if ($google) { $sources += @{ provider = 'google-drive'; publicUrl = $google } }
if ($sources.Count -eq 0) {
  Write-Output 'Upload the ZIP to Yandex Disk or Google Drive (public file link).'
  Write-Output 'Then rerun this script with -ZipPath, -Version, and -YandexUrl or -GoogleDriveUrl.'
  if (Test-Path -LiteralPath $outManifest) {
    Write-Warning 'A previous manifest exists. Do not publish it without regenerating for this ZIP.'
  }
  return
}
if ((Test-Path -LiteralPath $outManifest) -and !$Force) {
  throw "Manifest already exists at $outManifest. Use -Force to regenerate it."
}
$manifest = [ordered]@{
  schemaVersion = 1
  eventId = 'project-war'
  version = $Version
  sha256 = $hash
  sources = $sources
  forceConfigFiles = @($ForceConfigFiles)
}
$manifestJson = $manifest | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText($outManifest, $manifestJson, [Text.UTF8Encoding]::new($false))
Write-Output "Ready: $outManifest"
Write-Output 'Upload project-war.modpack.json to GitHub Releases (tag project-war-modpack, Pre-release).'
