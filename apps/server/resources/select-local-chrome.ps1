$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms

$dialog = [System.Windows.Forms.OpenFileDialog]::new()
$dialog.Title = "Select Google Chrome (chrome.exe or chromex.exe)"
$dialog.Filter = "Google Chrome (chrome.exe or chromex.exe)|chrome.exe;chromex.exe"
$dialog.FileName = ""
$dialog.Multiselect = $false
$dialog.CheckFileExists = $true
$dialog.CheckPathExists = $true
$dialog.RestoreDirectory = $true

try {
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($dialog.FileName)
    [Console]::Out.Write("SELECTED:" + [Convert]::ToBase64String($bytes))
  } else {
    [Console]::Out.Write("CANCELLED")
  }
} finally {
  $dialog.Dispose()
}
