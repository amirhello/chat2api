#Requires -Version 5.1
<#
.SYNOPSIS
  تست مستقیم Chat Bridge DeepSeek با URL مشخص و بدون نگهداری کلید در فایل.
#>
param(
  [string]$ChatUrl = '',
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$PromptParts
)

$ErrorActionPreference = 'Stop'
$key = if ($env:BRIDGE_API_KEY) { $env:BRIDGE_API_KEY } else { $env:CHAT_BRIDGE_API_KEY }
if ([string]::IsNullOrWhiteSpace($key)) {
  throw 'متغیر BRIDGE_API_KEY یا CHAT_BRIDGE_API_KEY تنظیم نشده است. ابتدا کلید را با npm run key بگیرید.'
}

$port = if ($env:BRIDGE_PORT) { $env:BRIDGE_PORT } else { 20258 }
$url = "http://127.0.0.1:$port/v1/chat/completions"
$prompt = if ($PromptParts -and $PromptParts.Count -gt 0) { $PromptParts -join ' ' } else { 'سلام' }
$body = @{
  model   = 'deepseek'
  stream  = $false
  messages = @(@{ role = 'user'; content = $prompt })
}
if (-not [string]::IsNullOrWhiteSpace($ChatUrl)) { $body.chat_url = $ChatUrl }
$body | ConvertTo-Json -Depth 8 | Set-Variable -Name bodyJson

Write-Host "📨 پرامپت: $prompt" -ForegroundColor Cyan
if ($ChatUrl) { Write-Host "🎯 گفتگو: $ChatUrl" -ForegroundColor DarkCyan }
Write-Host '⏳ در انتظار DeepSeek...' -ForegroundColor Yellow

try {
  $response = Invoke-WebRequest -Uri $url `
    -Method POST -Body $bodyJson -ContentType 'application/json' `
    -Headers @{ Authorization = "Bearer $key" } -UseBasicParsing -TimeoutSec 180
  $response.Content | ConvertFrom-Json | ForEach-Object {
    Write-Host '--- پاسخ ---' -ForegroundColor Green
    Write-Host $_.choices[0].message.content -ForegroundColor White
  }
} catch {
  Write-Host "❌ $($_.Exception.Message)" -ForegroundColor Red
  if ($_.Exception.Response) {
    $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
    Write-Host $reader.ReadToEnd() -ForegroundColor DarkRed
  }
  exit 1
}
