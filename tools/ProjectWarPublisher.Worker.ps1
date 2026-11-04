#requires -version 5.1
<#
  Internal Project War publisher worker.
  Run by ProjectWarPublisher.ps1; can also be used directly from PowerShell.
  The ZIP is uploaded to Yandex Disk / Google Drive separately. This tool
  publishes only the versioned JSON asset to GitHub Releases.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Build', 'Manifest', 'Publish')]
  [string] $Action,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$')]
  [string] $Version,

  [string] $SourceFolder = '',
  [string] $GoogleDriveUrl = '',
  [string] $YandexUrl = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$prepareScript = Join-Path $PSScriptRoot 'prepare-project-war.ps1'
$releaseDir = Join-Path (Join-Path $repoRoot 'project-war-release') $Version
$zipPath = Join-Path $releaseDir 'project-war.zip'
$manifestPath = Join-Path $releaseDir 'project-war.modpack.json'
$repo = 'Fastyk829/events-launcher'
$releaseTag = 'project-war-modpack'

if (!(Test-Path -LiteralPath $prepareScript -PathType Leaf)) {
  throw 'Не найден tools/prepare-project-war.ps1.'
}

function Call-Gh([string[]] $Arguments) {
  $command = Get-Command gh -CommandType Application -ErrorAction SilentlyContinue
  if (!$command) {
    throw 'GitHub CLI не установлен. Установи gh (cli.github.com) и выполни gh auth login.'
  }
  # Native CLI writes diagnostics to stderr. Check LASTEXITCODE instead of
  # treating its stderr as a PowerShell terminating error.
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = & $command.Source @Arguments 2>&1 | Out-String
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  return [pscustomobject]@{
    Code = $code
    Output = $output.Trim()
  }
}

switch ($Action) {
  'Build' {
    if (!(Test-Path -LiteralPath $SourceFolder -PathType Container)) {
      throw 'Выбери существующую папку сборки.'
    }
    if (Test-Path -LiteralPath $zipPath) {
      throw "ZIP для версии $Version уже существует. Укажи новую версию, чтобы не перезаписать архив."
    }
    & $prepareScript -SourceFolder $SourceFolder -Version $Version -OutputDirectory $releaseDir
    if (!(Test-Path -LiteralPath $zipPath -PathType Leaf)) {
      throw 'Скрипт не создал ZIP.'
    }
    Write-Output "ZIP готов: $zipPath"
    Write-Output 'Загрузи его в облако и скопируй публичную ссылку на ФАЙЛ.'
    break
  }

  'Manifest' {
    if (!(Test-Path -LiteralPath $zipPath -PathType Leaf)) {
      throw 'Сначала создай ZIP для этой версии.'
    }
    if ([string]::IsNullOrWhiteSpace($GoogleDriveUrl) -and [string]::IsNullOrWhiteSpace($YandexUrl)) {
      throw 'Укажи хотя бы одну публичную ссылку на ZIP-файл.'
    }
    $arguments = @{
      ZipPath = $zipPath
      Version = $Version
      OutputDirectory = $releaseDir
      Force = $true
    }
    $arguments['GoogleDriveUrl'] = $GoogleDriveUrl.Trim()
    $arguments['YandexUrl'] = $YandexUrl.Trim()
    & $prepareScript @arguments
    if (!(Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
      throw 'Скрипт не создал JSON-манифест.'
    }
    Write-Output "JSON готов: $manifestPath"
    break
  }

  'Publish' {
    if (!(Test-Path -LiteralPath $zipPath -PathType Leaf) -or
        !(Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
      throw 'Нужны ZIP и project-war.modpack.json. Сначала выполни предыдущие шаги.'
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or $manifest.eventId -ne 'project-war' -or
        $manifest.version -cne $Version -or
        $manifest.sha256 -cnotmatch '^[0-9a-f]{64}$' -or
        @($manifest.sources).Count -lt 1) {
      throw 'Некорректный или устаревший JSON-манифест.'
    }
    $currentHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($currentHash -cne $manifest.sha256) {
      throw 'ZIP изменился после создания JSON. Сначала пересоздай JSON и заново загрузи этот ZIP в облако.'
    }

    $authentication = Call-Gh -Arguments @('auth', 'status', '--hostname', 'github.com')
    if ($authentication.Code -ne 0) {
      throw 'В GitHub CLI нет авторизации. Открой PowerShell и выполни gh auth login.'
    }

    $existing = Call-Gh -Arguments @('api', "repos/$repo/releases/tags/$releaseTag")
    if ($existing.Code -eq 0) {
      $release = $existing.Output | ConvertFrom-Json
      if ($release.tag_name -cne $releaseTag -or
          $release.prerelease -ne $true -or $release.draft -eq $true) {
        throw 'Найденный GitHub Release должен быть опубликован как pre-release с тегом project-war-modpack.'
      }
      $uploaded = Call-Gh -Arguments @(
        'release', 'upload', $releaseTag, $manifestPath,
        '--clobber', '--repo', $repo
      )
      if ($uploaded.Code -ne 0) {
        throw "Не удалось обновить JSON в GitHub Release: $($uploaded.Output)"
      }
      Write-Output "Обновлён JSON для Project War $Version в GitHub Releases."
    } elseif ($existing.Output -match 'HTTP 404') {
      $created = Call-Gh -Arguments @(
        'release', 'create', $releaseTag, $manifestPath,
        '--repo', $repo, '--target', 'main', '--prerelease',
        '--title', 'Project War modpack metadata',
        '--notes', 'Version metadata for the Project War modpack.'
      )
      if ($created.Code -ne 0) {
        throw "Не удалось создать GitHub Release: $($created.Output)"
      }
      Write-Output "Создан pre-release с JSON для Project War $Version."
    } else {
      throw "Не удалось проверить релиз GitHub. Публикация отменена: $($existing.Output)"
    }
    Write-Output "https://github.com/$repo/releases/tag/$releaseTag"
    break
  }
}
