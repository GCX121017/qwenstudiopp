# Qwen Studio++ one-click installer (PowerShell)
# Usage: right-click this file -> "Run with PowerShell"; or in a terminal:
#   powershell -ExecutionPolicy Bypass -File install.ps1
# NOTE: window always waits for Enter before closing, so errors stay visible.
$ErrorActionPreference = "Continue"
function Wait-Exit([int]$Code) { $null = Read-Host "Press Enter to exit"; exit $Code }
try {
  Write-Host ""
  Write-Host "  ============================================" -ForegroundColor Cyan
  Write-Host "   Qwen Studio++ Setup for Windows PowerShell" -ForegroundColor Cyan
  Write-Host "  ============================================" -ForegroundColor Cyan
  Write-Host ""

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "  [X] Node.js not found" -ForegroundColor Red
    Write-Host "      Install Node.js 18+ LTS from https://nodejs.org first" -ForegroundColor Red
    Wait-Exit 1
  }
  Write-Host "  [1/3] Node.js found: $(node -v)"

  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "  [X] npm not found - it is bundled with Node.js" -ForegroundColor Red
    Wait-Exit 1
  }

  Write-Host "  [2/3] Installing qwen-studio-pp globally ..."
  Set-Location $PSScriptRoot
  npm install -g "$PSScriptRoot" --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  [X] Install failed - check the messages above" -ForegroundColor Red
    Wait-Exit 1
  }

  Write-Host "  [3/3] Verifying command ..."
  if (-not (Get-Command qspp -ErrorAction SilentlyContinue)) {
    Write-Host "  [!] 'qspp' is not in PATH yet" -ForegroundColor Yellow
    Write-Host "      Open a NEW terminal window, then run: qspp" -ForegroundColor Yellow
    Wait-Exit 1
  }

  Write-Host ""
  Write-Host "  ============================================" -ForegroundColor Green
  Write-Host "   Install complete!" -ForegroundColor Green
  Write-Host "   In any terminal type:  qspp" -ForegroundColor White
  Write-Host "  ============================================" -ForegroundColor Green
  Write-Host ""
  Wait-Exit 0
} catch {
  Write-Host ""
  Write-Host "  [X] Unexpected error: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "      You can always install manually instead:" -ForegroundColor Yellow
  Write-Host "      open a terminal in this folder and run:  npm install -g ." -ForegroundColor Yellow
  Wait-Exit 1
}
