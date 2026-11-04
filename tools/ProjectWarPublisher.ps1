#requires -version 5.1
# Small local Windows GUI for creating and publishing Project War modpacks.
# Uses prepare-project-war.ps1 for ZIP/manifest validation and GitHub CLI for
# the pre-release. No credentials or tokens are stored by this program.

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$script:repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$script:workerPath = Join-Path $PSScriptRoot 'ProjectWarPublisher.Worker.ps1'
$script:job = $null
$script:jobLogFiles = @()
$script:jobStatusFile = ''
$script:jobTitle = ''
# Each section owns its controls; unrelated controls are added to the form.
$script:activeSection = $null

$script:form = New-Object System.Windows.Forms.Form
$script:form.Text = 'Project War | Сборка и публикация'
$script:form.ClientSize = New-Object System.Drawing.Size(760, 625)
$script:form.FormBorderStyle = 'FixedDialog'
$script:form.MaximizeBox = $false
$script:form.MinimizeBox = $true
$script:form.StartPosition = 'CenterScreen'
$script:form.AutoScaleMode = 'Dpi'
$script:form.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$script:form.BackColor = [Drawing.Color]::FromArgb(22, 22, 26)
$script:form.ForeColor = [Drawing.Color]::FromArgb(235, 235, 239)

function Place-Control([System.Windows.Forms.Control]$control, [int]$x, [int]$y) {
  if ($null -ne $script:activeSection) {
    # Child control coordinates must be relative to the GroupBox.
    $control.Location = [Drawing.Point]::new(
      $x - $script:activeSection.Left,
      $y - $script:activeSection.Top
    )
    $script:activeSection.Controls.Add($control)
  } else {
    $control.Location = [Drawing.Point]::new($x, $y)
    $script:form.Controls.Add($control)
  }
}

function Add-Label([string]$text, [int]$x, [int]$y, [int]$width, [int]$height) {
  $label = New-Object System.Windows.Forms.Label
  $label.Text = $text
  $label.Size = New-Object System.Drawing.Size($width, $height)
  $label.ForeColor = $script:form.ForeColor
  Place-Control $label $x $y
  return $label
}

function Add-Box([int]$x, [int]$y, [int]$width) {
  $box = New-Object System.Windows.Forms.TextBox
  $box.Size = New-Object System.Drawing.Size($width, 25)
  $box.BackColor = [Drawing.Color]::FromArgb(35, 35, 40)
  $box.ForeColor = [Drawing.Color]::White
  $box.BorderStyle = 'FixedSingle'
  Place-Control $box $x $y
  return $box
}

function Add-Button([string]$text, [int]$x, [int]$y, [int]$width) {
  $button = New-Object System.Windows.Forms.Button
  $button.Text = $text
  $button.Size = New-Object System.Drawing.Size($width, 30)
  $button.FlatStyle = 'Flat'
  $button.FlatAppearance.BorderColor = [Drawing.Color]::FromArgb(85, 85, 95)
  $button.BackColor = [Drawing.Color]::FromArgb(49, 49, 56)
  $button.ForeColor = [Drawing.Color]::White
  Place-Control $button $x $y
  return $button
}

function Add-Section([string]$title, [int]$y, [int]$height) {
  $group = New-Object System.Windows.Forms.GroupBox
  $group.Text = $title
  $group.Location = New-Object System.Drawing.Point(18, $y)
  $group.Size = New-Object System.Drawing.Size(724, $height)
  $group.ForeColor = [Drawing.Color]::FromArgb(220, 220, 225)
  $script:form.Controls.Add($group)
  $script:activeSection = $group
  return $group
}

$title = Add-Label 'Project War Publisher' 19 15 550 30
$title.Font = New-Object System.Drawing.Font('Segoe UI', 17, [Drawing.FontStyle]::Bold)
$subtitle = Add-Label 'Локальный помощник по созданию модпака и обновлению GitHub Releases.' 21 53 710 20
$subtitle.ForeColor = [Drawing.Color]::FromArgb(155, 155, 165)

$null = Add-Section '1. Упаковать моды и настройки' 78 145
$null = Add-Label 'Папка сборки (внутри должны быть mods/, config/ и т. п.)' 35 104 650 19
$script:folderBox = Add-Box 35 127 570
$script:browseButton = Add-Button 'Выбрать...' 615 125 105
$null = Add-Label 'Версия:' 35 173 58 21
$script:versionBox = Add-Box 95 171 105
$script:versionBox.Text = '1.0.0'
$script:buildButton = Add-Button 'Создать ZIP' 214 168 157
$script:openButton = Add-Button 'Открыть папку ZIP' 383 168 174

$null = Add-Section '2. Загрузить ZIP в облако и подготовить JSON' 231 146
$null = Add-Label 'Google Drive:' 35 262 105 21
$script:googleUrlBox = Add-Box 145 258 575
$null = Add-Label 'Яндекс Диск:' 35 301 105 21
$script:yandexUrlBox = Add-Box 145 297 575
$null = Add-Label 'Публичные ссылки на один и тот же ZIP. Можно указать одну или обе.' 35 335 505 32
$script:manifestButton = Add-Button 'Создать JSON' 555 335 165

$null = Add-Section '3. Опубликовать в GitHub Releases' 386 101
$null = Add-Label 'Тег: project-war-modpack (pre-release). Требуется GitHub CLI и gh auth login.' 35 413 505 38
$script:publishButton = Add-Button 'Опубликовать' 555 417 165

# Below the sections the log belongs to the form itself.
$script:activeSection = $null
$null = Add-Label 'Ход работы' 20 497 150 20
$script:logBox = New-Object System.Windows.Forms.TextBox
$script:logBox.Location = New-Object System.Drawing.Point(18, 521)
$script:logBox.Size = New-Object System.Drawing.Size(724, 87)
$script:logBox.Multiline = $true
$script:logBox.ReadOnly = $true
$script:logBox.ScrollBars = 'Vertical'
$script:logBox.BackColor = [Drawing.Color]::FromArgb(31, 31, 36)
$script:logBox.ForeColor = [Drawing.Color]::FromArgb(221, 221, 226)
$script:form.Controls.Add($script:logBox)

function Append-Log([string]$message) {
  if ([string]::IsNullOrWhiteSpace($message)) { return }
  $script:logBox.AppendText($message.TrimEnd() + [Environment]::NewLine)
}

function Get-ReleaseDirectory {
  $version = $script:versionBox.Text.Trim()
  if ($version -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$') {
    throw 'Версия должна быть вида 1.0.0 или 1.0.1 (латиница и цифры).'
  }
  return (Join-Path (Join-Path $script:repoRoot 'project-war-release') $version)
}

function Quote-PS([string]$value) {
  return "'" + $value.Replace("'", "''") + "'"
}

function Set-Busy([bool]$busy) {
  foreach ($button in @($script:browseButton, $script:buildButton,
                        $script:openButton, $script:manifestButton,
                        $script:publishButton)) {
    $button.Enabled = !$busy
  }
}

$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = 350
$script:timer.Add_Tick({
  if (!$script:job -or !$script:job.HasExited) { return }
  $script:timer.Stop()
  # WaitForExit flushes redirected streams. Start-Process can return a process
  # whose ExitCode is unavailable in this WinForms timer on Windows PowerShell.
  try { $script:job.WaitForExit() } catch {}
  $script:job.Dispose()
  $script:job = $null

  $result = ''
  if ($script:jobStatusFile -and (Test-Path -LiteralPath $script:jobStatusFile -PathType Leaf)) {
    try { $result = [IO.File]::ReadAllText($script:jobStatusFile).Trim() }
    finally {
      Remove-Item -LiteralPath $script:jobStatusFile -Force -ErrorAction SilentlyContinue
    }
  }
  $script:jobStatusFile = ''

  foreach ($file in $script:jobLogFiles) {
    if (Test-Path -LiteralPath $file -PathType Leaf) {
      try {
        $message = [IO.File]::ReadAllText($file, [Text.Encoding]::UTF8)
        # Windows PowerShell serializes progress/information as CLIXML into
        # redirected stderr. It is not an operation error or user-facing log.
        if ($message -and $message.TrimStart().TrimStart([char]0xFEFF) -notmatch '^#< CLIXML') {
          Append-Log $message
        }
      } catch {
        Append-Log "Не удалось прочитать вывод операции: $($_.Exception.Message)"
      } finally {
        Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
      }
    }
  }
  $script:jobLogFiles = @()
  if ($result -eq 'ok') {
    Append-Log "Готово: $($script:jobTitle)."
  } elseif ($result -eq 'failed') {
    Append-Log "Ошибка при выполнении: $($script:jobTitle)."
  } else {
    Append-Log "Не удалось определить результат операции. Проверь файлы и журнал."
  }
  Set-Busy $false
})

function Start-Task([string]$action, [string]$description) {
  if ($script:job) { return }
  try {
    $version = $script:versionBox.Text.Trim()
    $null = Get-ReleaseDirectory
    $folder = $script:folderBox.Text.Trim()
    $googleUrl = $script:googleUrlBox.Text.Trim()
    $yandexUrl = $script:yandexUrlBox.Text.Trim()

    # A separate status file tells the GUI whether the script succeeded.
    # This is more reliable than Start-Process.ExitCode with redirected output.
    $base = Join-Path ([IO.Path]::GetTempPath()) ('pw-publisher-' + [Guid]::NewGuid().ToString('N'))
    $stdout = $base + '.out'
    $stderr = $base + '.err'
    $statusFile = $base + '.status'

    # EncodedCommand avoids argument quoting mistakes with Cyrillic paths.
    $invoke = '& ' + (Quote-PS $script:workerPath) +
      ' -Action ' + (Quote-PS $action) +
      ' -Version ' + (Quote-PS $version) +
      ' -SourceFolder ' + (Quote-PS $folder) +
      ' -GoogleDriveUrl ' + (Quote-PS $googleUrl) +
      ' -YandexUrl ' + (Quote-PS $yandexUrl)
    $command = '$ProgressPreference = ''SilentlyContinue''; ' +
      '$ErrorActionPreference = ''Stop''; ' +
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8; try { ' +
      $invoke + '; [IO.File]::WriteAllText(' + (Quote-PS $statusFile) + ', ''ok'')' +
      ' } catch { [Console]::Error.WriteLine($_.Exception.Message); ' +
      '[IO.File]::WriteAllText(' + (Quote-PS $statusFile) + ', ''failed''); exit 1 }'
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))

    $script:jobTitle = $description
    $script:jobStatusFile = $statusFile
    Set-Busy $true
    Append-Log "Запущено: $description..."
    $script:job = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList (
      "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded"
    ) -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $script:jobLogFiles = @($stdout, $stderr)
    $script:timer.Start()
  } catch {
    $script:job = $null
    $script:jobStatusFile = ''
    Set-Busy $false
    Append-Log $_.Exception.Message
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Ошибка', 'OK', 'Error') | Out-Null
  }
}

$script:browseButton.Add_Click({
  $picker = New-Object System.Windows.Forms.FolderBrowserDialog
  $picker.Description = 'Выбери папку Project War, где находятся mods/ и config/.'
  try {
    if ($picker.ShowDialog($script:form) -eq 'OK') {
      $script:folderBox.Text = $picker.SelectedPath
    }
  } finally { $picker.Dispose() }
})

$script:buildButton.Add_Click({
  if (!(Test-Path -LiteralPath $script:folderBox.Text.Trim() -PathType Container)) {
    [System.Windows.Forms.MessageBox]::Show('Сначала выбери папку со сборкой.', 'Project War', 'OK', 'Warning') | Out-Null
    return
  }
  Start-Task 'Build' 'создание ZIP'
})

$script:openButton.Add_Click({
  try {
    $directory = Get-ReleaseDirectory
    if (!(Test-Path -LiteralPath $directory -PathType Container)) {
      throw 'Сначала создай ZIP для выбранной версии.'
    }
    Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $directory + '"')
  } catch { Append-Log $_.Exception.Message }
})

$script:manifestButton.Add_Click({
  if ([string]::IsNullOrWhiteSpace($script:googleUrlBox.Text) -and [string]::IsNullOrWhiteSpace($script:yandexUrlBox.Text)) {
    [System.Windows.Forms.MessageBox]::Show('Сначала загрузи ZIP на Яндекс Диск или Google Drive и вставь хотя бы одну публичную ссылку на файл.', 'Project War', 'OK', 'Warning') | Out-Null
    return
  }
  Start-Task 'Manifest' 'подготовка JSON'
})

$script:publishButton.Add_Click({
  try {
    $directory = Get-ReleaseDirectory
    $manifestPath = Join-Path $directory 'project-war.modpack.json'
    if (!(Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
      throw 'Сначала создай JSON по публичной ссылке на ZIP.'
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $links = @($manifest.sources | ForEach-Object { $_.provider + ': ' + $_.publicUrl }) -join [Environment]::NewLine
    $message = 'Опубликовать Project War ' + $manifest.version + ' в GitHub Releases?' +
      [Environment]::NewLine + [Environment]::NewLine +
      'Один и тот же ZIP должен быть доступен по указанным ссылкам:' +
      [Environment]::NewLine + $links +
      [Environment]::NewLine + [Environment]::NewLine +
      'Будет создан или обновлён pre-release project-war-modpack.'
    $answer = [System.Windows.Forms.MessageBox]::Show(
      $message, 'Подтверждение публикации', 'YesNo', 'Question'
    )
    if ($answer -eq 'Yes') { Start-Task 'Publish' 'публикация GitHub Release' }
  } catch {
    Append-Log $_.Exception.Message
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Project War', 'OK', 'Warning') | Out-Null
  }
})

$script:form.Add_FormClosing({
  if ($script:job) {
    $_.Cancel = $true
    [System.Windows.Forms.MessageBox]::Show(
      'Дождись завершения текущей операции.', 'Project War', 'OK', 'Information'
    ) | Out-Null
  }
})

Append-Log '1) Выбери папку с mods/, укажи версию и создай ZIP.'
Append-Log '2) Загрузи один ZIP в Google Drive и/или Яндекс Диск, вставь ссылки и создай JSON.'
Append-Log '3) Нажми «Опубликовать» после проверки публичной ссылки.'
[void]$script:form.ShowDialog()
$script:timer.Dispose()
$script:form.Dispose()
