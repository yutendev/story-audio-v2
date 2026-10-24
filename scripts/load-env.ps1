# Nạp biến từ một file .env vào session hiện tại (PowerShell).
# Usage:  . .\scripts\load-env.ps1            # nạp .\.env
#         . .\scripts\load-env.ps1 -Path x.env
param([string]$Path)

if (-not $Path) {
    $callerParent = Split-Path -Parent $PSScriptRoot
    $Path = Join-Path $callerParent ".env"
}
if (-not (Test-Path $Path)) { throw "không tìm thấy $Path (copy .env.example trước)" }

Get-Content $Path | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
        # dòng này chỉ để session nạp env; value không in ra (chống leak key)
        Set-Item -Path ("env:" + $Matches[1]) -Value ($Matches[2].Trim().Trim('"').Trim("'"))
    }
}
Write-Output "env loaded: $Path"
