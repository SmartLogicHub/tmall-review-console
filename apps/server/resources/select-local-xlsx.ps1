$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms

$dialog = [System.Windows.Forms.OpenFileDialog]::new()
$dialog.Title = (-join [char[]](36873, 25321, 20154, 24037, 22788, 29702, 21830, 21697)) + " Excel " + (-join [char[]](21517, 21333))
$dialog.Filter = "Excel " + (-join [char[]](24037, 20316, 31807)) + " (*.xlsx)|*.xlsx"
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
