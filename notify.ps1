Add-Type -AssemblyName System.Windows.Forms
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.Visible = $true
$n.ShowBalloonTip(5000, 'Claude Code', 'Task Complete!', [System.Windows.Forms.ToolTipIcon]::Info)
Start-Sleep 4
$n.Dispose()
