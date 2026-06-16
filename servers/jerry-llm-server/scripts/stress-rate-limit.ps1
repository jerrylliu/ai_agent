# ==============================================================================
# 限流快速压测脚本（PowerShell 5.1 / 7 通用版）
# ==============================================================================
# 使用：
#   ./scripts/stress-rate-limit.ps1            # 默认连发 10 次
#   ./scripts/stress-rate-limit.ps1 -Count 20  # 自定义次数
# ==============================================================================

param(
  [int]    $Count   = 10,
  [string] $BaseUrl = 'http://localhost:3000',
  [string] $UserToken = $null
)

$ErrorActionPreference = 'Stop'

Write-Host "`n压测目标: $BaseUrl/chat/prompt" -ForegroundColor Cyan
Write-Host "连发次数: $Count`n" -ForegroundColor Cyan

$headers = @{ 'Content-Type' = 'application/json' }
if ($UserToken) { $headers['Authorization'] = "Bearer $UserToken" }

# 兼容 PS5/7 的 HTTP 请求函数
function Invoke-Once {
  param([string] $Body)
  try {
    $resp = Invoke-WebRequest -Uri "$BaseUrl/chat/prompt" -Method POST `
      -Headers $headers -Body $Body -TimeoutSec 30 -UseBasicParsing
    return @{ Status = [int]$resp.StatusCode; Headers = $resp.Headers }
  } catch [System.Net.WebException] {
    $r = $_.Exception.Response
    if ($r) {
      $h = @{}
      foreach ($key in $r.Headers.AllKeys) { $h[$key] = $r.Headers[$key] }
      return @{ Status = [int]$r.StatusCode; Headers = $h }
    }
    return @{ Status = 0; Headers = @{} }
  } catch [Microsoft.PowerShell.Commands.HttpResponseException] {
    $r = $_.Exception.Response
    $h = @{}
    foreach ($entry in $r.Headers) { $h[$entry.Key] = $entry.Value -join ',' }
    return @{ Status = [int]$r.StatusCode; Headers = $h }
  } catch {
    return @{ Status = 0; Headers = @{} }
  }
}

function Get-H($headers, $name) {
  if ($null -eq $headers) { return '-' }
  try {
    $v = $headers[$name]
    if ($null -eq $v) { return '-' }
    if ($v -is [System.Array]) { return ($v[0]).ToString() }
    return $v.ToString()
  } catch { return '-' }
}

$start = Get-Date
$results = @()

for ($i = 1; $i -le $Count; $i++) {
  $body = @{
    message   = "stress-$i"
    sessionId = "stress-test-$i"
  } | ConvertTo-Json -Compress

  $reqStart = Get-Date
  $r = Invoke-Once -Body $body
  $elapsedMs = [Math]::Round((New-TimeSpan -Start $reqStart -End (Get-Date)).TotalMilliseconds, 0)

  $remaining = Get-H $r.Headers 'X-RateLimit-Remaining'
  $retryAfter = Get-H $r.Headers 'Retry-After'

  $color = switch ($r.Status) {
    200     { 'Green' }
    429     { 'Yellow' }
    409     { 'Magenta' }
    default { 'Red' }
  }
  $line = "  #{0,-3} HTTP {1,-3} | Remaining: {2,-4} | RetryAfter: {3,-4} | {4} ms" -f `
    $i, $r.Status, $remaining, $retryAfter, $elapsedMs
  Write-Host $line -ForegroundColor $color

  $results += [PSCustomObject]@{
    No = $i; Status = $r.Status; Remaining = $remaining; RetryAfter = $retryAfter; ElapsedMs = $elapsedMs
  }
}

$totalMs = [Math]::Round((New-TimeSpan -Start $start -End (Get-Date)).TotalMilliseconds, 0)

Write-Host "`n汇总：" -ForegroundColor Cyan
$grouped = $results | Group-Object Status | Sort-Object Name
foreach ($g in $grouped) {
  $color = switch ([int]$g.Name) {
    200 { 'Green' } 429 { 'Yellow' } 409 { 'Magenta' } default { 'Red' }
  }
  Write-Host "  HTTP $($g.Name): $($g.Count) 次" -ForegroundColor $color
}
Write-Host "  总耗时: $totalMs ms`n" -ForegroundColor Cyan

if (($results | Where-Object { $_.Status -eq 429 }).Count -gt 0) {
  Write-Host '检测到 429 响应，限流工作正常' -ForegroundColor Green
  exit 0
} else {
  Write-Host '没有 429 响应。可能原因：' -ForegroundColor Yellow
  Write-Host '   1. RATE_LIMIT_CHAT_PER_MIN 设得太大（建议测试时改为 5）' -ForegroundColor Gray
  Write-Host "   2. 发送次数（$Count）小于阈值，请加大 -Count" -ForegroundColor Gray
  Write-Host '   3. RateLimitGuard 未生效（检查 chat.controller.ts）' -ForegroundColor Gray
  exit 1
}
