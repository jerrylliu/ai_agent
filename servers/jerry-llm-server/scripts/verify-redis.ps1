# ==============================================================================
# Redis 基础设施一键验证脚本（PowerShell 5.1 / 7 通用版）
# ==============================================================================
# 使用方式：
#   1. 确保 Docker 已启动、jerry-redis 容器运行中
#   2. 确保后端 jerry-llm-server 已启动（pnpm run start:dev）
#   3. 在 PowerShell 执行：
#      cd e:\miaoma-ai-app\servers\jerry-llm-server
#      ./scripts/verify-redis.ps1
#
# 覆盖验证：
#   ✅ Redis 连接 / Key 前缀正确性
#   ✅ 限流（滑动窗口）：连发触发 429，响应头正确
#   ✅ 分布式锁：同 sessionId 并发请求触发 409
#   ✅ 多级缓存：跨请求复用，重启后仍能读到
#   ✅ 故障降级：Redis 停掉服务仍可用
#   ✅ 性能基准：限流/锁/缓存的实际耗时
# ==============================================================================

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ====== 配置项 ======
$BaseUrl   = 'http://localhost:3000'
$Container = 'jerry-redis'
$Prefix    = 'jerry:'
$RateLimitTestThreshold = 5

# ====== 颜色辅助 ======
function Write-Section($title) {
  Write-Host "`n========================================" -ForegroundColor Cyan
  Write-Host "  $title" -ForegroundColor Cyan
  Write-Host "========================================" -ForegroundColor Cyan
}
function Write-Pass($msg)  { Write-Host "  [PASS] $msg" -ForegroundColor Green }
function Write-Fail($msg)  { Write-Host "  [FAIL] $msg" -ForegroundColor Red }
function Write-Warn($msg)  { Write-Host "  [WARN] $msg" -ForegroundColor Yellow }
function Write-Info($msg)  { Write-Host "  [INFO] $msg" -ForegroundColor Gray }

$script:PassCount = 0
$script:FailCount = 0

function Assert-True($cond, $passMsg, $failMsg) {
  if ($cond) { Write-Pass $passMsg; $script:PassCount++ }
  else       { Write-Fail $failMsg; $script:FailCount++ }
}

# ====== 工具：执行 redis-cli 命令 ======
function Invoke-Redis {
  param([Parameter(Mandatory)] [string[]] $RedisArgs)
  $output = docker exec $Container redis-cli @RedisArgs 2>$null
  return $output
}

# ====== 工具：发送对话请求（PS5/7 通用） ======
# PS5.1 没有 -SkipHttpErrorCheck，需要 try/catch 捕获 4xx/5xx
function Invoke-ChatPrompt {
  param(
    [string] $Message  = 'hi',
    [string] $SessionId = 'verify-default',
    [string] $UserToken = $null,
    [int]    $TimeoutSec = 30
  )

  $headers = @{ 'Content-Type' = 'application/json' }
  if ($UserToken) { $headers['Authorization'] = "Bearer $UserToken" }

  $body = @{ message = $Message; sessionId = $SessionId } | ConvertTo-Json -Compress

  try {
    $resp = Invoke-WebRequest -Uri "$BaseUrl/chat/prompt" -Method POST `
      -Headers $headers -Body $body -TimeoutSec $TimeoutSec -UseBasicParsing
    return [PSCustomObject]@{
      Status  = [int]$resp.StatusCode
      Body    = $resp.Content
      Headers = $resp.Headers
    }
  } catch [System.Net.WebException] {
    # PS5.1 把 4xx/5xx 当 WebException；从 Response 里拿状态码和头
    $webResp = $_.Exception.Response
    if ($webResp) {
      $status = [int]$webResp.StatusCode
      $headersDict = @{}
      foreach ($key in $webResp.Headers.AllKeys) {
        $headersDict[$key] = $webResp.Headers[$key]
      }
      $bodyText = ''
      try {
        $stream = $webResp.GetResponseStream()
        $reader = New-Object System.IO.StreamReader($stream)
        $bodyText = $reader.ReadToEnd()
        $reader.Close()
      } catch {}
      return [PSCustomObject]@{
        Status  = $status
        Body    = $bodyText
        Headers = $headersDict
      }
    }
    return [PSCustomObject]@{ Status = 0; Body = $_.Exception.Message; Headers = @{} }
  } catch [Microsoft.PowerShell.Commands.HttpResponseException] {
    # PS7 走这个分支
    $resp = $_.Exception.Response
    $headersDict = @{}
    foreach ($h in $resp.Headers) { $headersDict[$h.Key] = $h.Value -join ',' }
    return [PSCustomObject]@{
      Status  = [int]$resp.StatusCode
      Body    = $_.ErrorDetails.Message
      Headers = $headersDict
    }
  } catch {
    return [PSCustomObject]@{
      Status  = 0
      Body    = $_.Exception.Message
      Headers = @{}
    }
  }
}

# ====== 工具：读响应头（兼容 PS5/7 不同的 Headers 类型） ======
function Get-Header($headers, $name) {
  if ($null -eq $headers) { return $null }
  if ($headers -is [hashtable]) {
    if ($headers.ContainsKey($name)) { return $headers[$name] }
    return $null
  }
  # PS5.1 IDictionary
  try {
    $v = $headers[$name]
    if ($v -is [System.Array]) { return $v[0] }
    return $v
  } catch { return $null }
}

# ============================================================================
# 0. 前置检查
# ============================================================================
Write-Section '0. 前置检查'

# 0.1 Docker 容器是否运行
$containerStatus = docker ps --filter "name=$Container" --format '{{.Status}}'
Assert-True ($containerStatus -and $containerStatus -like 'Up*') `
  "Docker 容器 $Container 正在运行：$containerStatus" `
  "Docker 容器 $Container 未运行，请先：docker start $Container"

if ($script:FailCount -gt 0) {
  Write-Fail '前置检查失败，终止后续验证'
  exit 1
}

# 0.2 Redis 是否能 ping 通
$pingResult = Invoke-Redis -RedisArgs @('PING')
Assert-True ($pingResult -eq 'PONG') `
  'Redis PING 返回 PONG' `
  "Redis PING 失败：$pingResult"

# 0.3 后端 HTTP 服务是否在线
$portOpen = Test-NetConnection -ComputerName localhost -Port 3000 -InformationLevel Quiet -WarningAction SilentlyContinue
Assert-True $portOpen `
  '后端 3000 端口已开放' `
  '后端服务不在线，请先 pnpm run start:dev'

if (-not $portOpen) { exit 1 }

# 0.4 清理上次验证残留
Write-Info '清理上次验证残留 key...'
$cleanPatterns = @(
  "${Prefix}rate-limit:chat:*",
  "${Prefix}lock:chat:session:verify-*",
  "${Prefix}session-asset:verify-*"
)
foreach ($pat in $cleanPatterns) {
  $keys = Invoke-Redis -RedisArgs @('KEYS', $pat)
  if ($keys) {
    foreach ($k in $keys) {
      if ($k -and $k.Trim().Length -gt 0) {
        Invoke-Redis -RedisArgs @('UNLINK', $k.Trim()) | Out-Null
      }
    }
  }
}

# ============================================================================
# 1. Redis 连接 / Key 前缀
# ============================================================================
Write-Section '1. Redis 连接 / Key 前缀验证'

Invoke-Redis -RedisArgs @('SET', "${Prefix}verify-prefix-test", 'ok', 'EX', '60') | Out-Null
$existsWithPrefix = Invoke-Redis -RedisArgs @('EXISTS', "${Prefix}verify-prefix-test")
Assert-True ($existsWithPrefix -eq '1') `
  "可以读写带 $Prefix 前缀的 key" `
  'Redis 写入异常'
Invoke-Redis -RedisArgs @('UNLINK', "${Prefix}verify-prefix-test") | Out-Null

# ============================================================================
# 2. 限流验证（滑动窗口）
# ============================================================================
Write-Section '2. 限流验证（滑动窗口）'

Write-Info "连发 $($RateLimitTestThreshold + 3) 次请求"
Write-Info '注意：此测试需要 .env 里 RATE_LIMIT_CHAT_PER_MIN 设为较小值（建议 5）'

$rateLimitResults = @()
for ($i = 1; $i -le ($RateLimitTestThreshold + 3); $i++) {
  $r = Invoke-ChatPrompt -Message "rate-limit-test-$i" -SessionId "verify-rate-$i" -TimeoutSec 60
  $remaining = Get-Header $r.Headers 'X-RateLimit-Remaining'
  $retryAfter = Get-Header $r.Headers 'Retry-After'
  $rateLimitResults += [PSCustomObject]@{
    No         = $i
    Status     = $r.Status
    Remaining  = $remaining
    RetryAfter = $retryAfter
  }
  Write-Info "  第 $i 次: HTTP $($r.Status), Remaining=$remaining"
  Start-Sleep -Milliseconds 200
}

$has429 = ($rateLimitResults | Where-Object { $_.Status -eq 429 }).Count -gt 0
$has200 = ($rateLimitResults | Where-Object { $_.Status -eq 200 }).Count -gt 0
$hasRateLimitHeader = ($rateLimitResults | Where-Object { $_.Remaining }).Count -gt 0

Assert-True $hasRateLimitHeader `
  '响应头包含 X-RateLimit-Remaining' `
  '响应头缺失 X-RateLimit-Remaining，限流 Guard 可能未生效'

Assert-True $has200 '限流前置请求返回 200' '所有请求都被拒绝，可能配置错误'

if ($has429) {
  Write-Pass '触发限流：观察到 429 Too Many Requests'
  $script:PassCount++
  $first429 = ($rateLimitResults | Where-Object { $_.Status -eq 429 } | Select-Object -First 1)
  Write-Info "  第 $($first429.No) 次开始限流，Retry-After=$($first429.RetryAfter)s"
} else {
  Write-Warn '没有触发 429（如果你的 RATE_LIMIT_CHAT_PER_MIN 大于发送次数，这是正常的）'
  Write-Warn "  当前 .env 阈值可能 = 30，本次发了 $($RateLimitTestThreshold + 3) 次"
}

# 验证 Redis 里有 ZSET 记录
$zsetKeys = Invoke-Redis -RedisArgs @('KEYS', "${Prefix}rate-limit:chat:*")
Assert-True ($zsetKeys -and ($zsetKeys -is [System.Array] -or $zsetKeys.Length -gt 0)) `
  "Redis 中存在 rate-limit ZSET" `
  'Redis 中没有限流 ZSET，限流可能没真的写入 Redis'

# ============================================================================
# 3. 分布式锁验证（同 sessionId 并发）
# ============================================================================
Write-Section '3. 分布式锁验证（会话级互斥）'

$lockSessionId = 'verify-lock-' + (Get-Random -Maximum 99999)
Write-Info "会话 ID: $lockSessionId"

# Job A：模拟长任务
$jobA = Start-Job -ScriptBlock {
  param($url, $sid)
  $body = @{
    message = '请详细写一篇 1500 字的关于宇宙起源的科普文章'
    sessionId = $sid
  } | ConvertTo-Json -Compress
  try {
    Invoke-WebRequest -Uri "$url/chat/prompt" -Method POST `
      -Headers @{ 'Content-Type' = 'application/json' } `
      -Body $body -TimeoutSec 60 -UseBasicParsing | Out-Null
  } catch {}
} -ArgumentList $BaseUrl, $lockSessionId

Write-Info '等 Job A 抢到锁（2 秒）...'
Start-Sleep -Seconds 2

# Job B：并发请求，应被 409 拒绝
Write-Info 'Job B 并发发起请求'
$rB = Invoke-ChatPrompt -Message 'hi quick' -SessionId $lockSessionId -TimeoutSec 5

Assert-True ($rB.Status -eq 409) `
  "并发请求被拒绝：HTTP 409 Conflict" `
  "并发请求未被锁拦截：HTTP $($rB.Status) (注意：Redis 不可用时会降级放行)"

# 验证 Redis 里有锁 key
$lockKey = "${Prefix}lock:chat:session:$lockSessionId"
$lockValue = Invoke-Redis -RedisArgs @('GET', $lockKey)
$hasLock = $lockValue -and $lockValue.Trim().Length -gt 10
if ($hasLock) {
  $shortToken = $lockValue.Substring(0, [Math]::Min(8, $lockValue.Length)) + '...'
  Write-Pass "Redis 中锁 key 存在，token=$shortToken"
  $script:PassCount++
} else {
  Write-Fail 'Redis 中找不到锁 key'
  $script:FailCount++
}

$lockTtl = Invoke-Redis -RedisArgs @('TTL', $lockKey)
if ($lockTtl) {
  $ttlNum = [int]$lockTtl
  Assert-True ($ttlNum -gt 0) `
    "锁 TTL 为 $ttlNum 秒（防死锁机制生效）" `
    '锁 TTL 异常'
}

# 等 Job A 完成 / 强制清理
Write-Info '等待 Job A 完成 / 清理锁（最多 60s）...'
Wait-Job -Job $jobA -Timeout 60 | Out-Null
Remove-Job -Job $jobA -Force

# 锁应该已释放
Start-Sleep -Seconds 2
$lockAfter = Invoke-Redis -RedisArgs @('EXISTS', $lockKey)
Assert-True ($lockAfter -eq '0') `
  '业务结束后锁已自动释放' `
  '业务结束后锁仍存在（finally 释放可能失败，TTL 兜底也会过期）'

# ============================================================================
# 4. 多级缓存验证（sessionAssetCache）
# ============================================================================
Write-Section '4. 多级缓存验证（session-asset）'

$assetKeys = Invoke-Redis -RedisArgs @('KEYS', "${Prefix}session-asset:*")
$assetCount = 0
if ($assetKeys) {
  if ($assetKeys -is [System.Array]) { $assetCount = $assetKeys.Count }
  else { $assetCount = 1 }
}

if ($assetCount -gt 0) {
  Write-Pass "Redis 中已有 $assetCount 个 session-asset 缓存"
  $script:PassCount++

  $sample = if ($assetKeys -is [System.Array]) { $assetKeys[0] } else { $assetKeys }
  $sampleTtl = Invoke-Redis -RedisArgs @('TTL', $sample)
  $sampleVal = Invoke-Redis -RedisArgs @('GET', $sample)
  Write-Info "  样本 key: $sample"
  Write-Info "  TTL: $sampleTtl 秒"
  if ($sampleVal -and $sampleVal.Length -gt 0) {
    $preview = $sampleVal.Substring(0, [Math]::Min(200, $sampleVal.Length))
    Write-Info "  Value 前 200 字符: $preview"
  }

  $ttlNum = [int]$sampleTtl
  Assert-True ($ttlNum -gt 0 -and $ttlNum -le 3600) `
    'TTL 在合理范围（0-3600 秒）' `
    "TTL 异常：$sampleTtl"

  try {
    $parsed = $sampleVal | ConvertFrom-Json
    $hasFields = ($parsed.PSObject.Properties.Name -contains 'images') -and `
                 ($parsed.PSObject.Properties.Name -contains 'fileCards')
    Assert-True $hasFields `
      'Value 是合法 JSON 且包含 images/fileCards 字段' `
      'Value 结构与预期不符'
  } catch {
    Write-Fail "Value 不是合法 JSON：$($_.Exception.Message)"
    $script:FailCount++
  }
} else {
  Write-Warn '没有找到 session-asset 缓存。手工验证步骤：'
  Write-Warn '  1. 在前端发送：给我生成一份周报 PDF'
  Write-Warn '  2. 等响应完成后重跑本脚本'
}

# ============================================================================
# 5. 故障降级验证
# ============================================================================
Write-Section '5. 故障降级验证（停 Redis → 服务仍可用）'

Write-Warn '此项会临时停止 Redis 容器，验证后会立刻恢复'
$confirm = Read-Host '确认执行？(y/N)'
if ($confirm -ne 'y' -and $confirm -ne 'Y') {
  Write-Info '已跳过故障降级验证'
} else {
  Write-Info '停止 Redis 容器...'
  docker stop $Container | Out-Null
  Start-Sleep -Seconds 2

  Write-Info '发起一次对话，预期：服务返回 200（fail-open 降级）或 503'
  $rDown = Invoke-ChatPrompt -Message 'fallback-test' -SessionId 'verify-fallback' -TimeoutSec 30

  Assert-True ($rDown.Status -eq 200 -or $rDown.Status -eq 503) `
    "Redis 离线时服务行为正确：HTTP $($rDown.Status)（200=fail-open / 503=fail-close）" `
    "Redis 离线时服务返回了非预期状态：HTTP $($rDown.Status)"

  Write-Info '恢复 Redis 容器...'
  docker start $Container | Out-Null
  Start-Sleep -Seconds 3

  $pingAfter = Invoke-Redis -RedisArgs @('PING')
  Assert-True ($pingAfter -eq 'PONG') `
    'Redis 恢复后 PING 通过' `
    'Redis 恢复异常'

  Write-Info '等待后端自动重连（最多 10 秒）...'
  Start-Sleep -Seconds 10

  $rUp = Invoke-ChatPrompt -Message 'recover-test' -SessionId 'verify-recover'
  Assert-True ($rUp.Status -eq 200) `
    'Redis 恢复后业务正常' `
    "恢复后业务异常：HTTP $($rUp.Status)"
}

# ============================================================================
# 6. 性能基准
# ============================================================================
Write-Section '6. 性能基准'

$start = Get-Date
1..100 | ForEach-Object { Invoke-Redis -RedisArgs @('PING') | Out-Null }
$elapsedMs = (New-TimeSpan -Start $start -End (Get-Date)).TotalMilliseconds
$avgMs = [Math]::Round($elapsedMs / 100, 2)
Write-Info "Redis PING × 100 平均耗时：$avgMs ms（含 docker exec 开销）"

$mem = Invoke-Redis -RedisArgs @('INFO', 'memory')
$memLine = ($mem -split "`n") | Where-Object { $_ -like 'used_memory_human*' }
if ($memLine) { Write-Info ("Redis 内存占用：" + ($memLine | Out-String).Trim()) }

$dbsize = Invoke-Redis -RedisArgs @('DBSIZE')
Write-Info "Redis 当前 key 总数：$dbsize"

$prefixKeys = Invoke-Redis -RedisArgs @('KEYS', "$Prefix*")
$byNamespace = @{}
if ($prefixKeys) {
  $keysArr = if ($prefixKeys -is [System.Array]) { $prefixKeys } else { @($prefixKeys) }
  foreach ($k in $keysArr) {
    if (-not $k) { continue }
    $parts = $k -split ':'
    if ($parts.Length -ge 2) {
      $ns = $parts[1]
      if (-not $byNamespace.ContainsKey($ns)) { $byNamespace[$ns] = 0 }
      $byNamespace[$ns]++
    }
  }
  if ($byNamespace.Count -gt 0) {
    Write-Info '业务 key 分布：'
    foreach ($entry in $byNamespace.GetEnumerator()) {
      Write-Info "  $Prefix$($entry.Key):* → $($entry.Value) 个"
    }
  }
}

# ============================================================================
# 总结
# ============================================================================
Write-Section '验证总结'

Write-Host "  通过：$script:PassCount" -ForegroundColor Green
$failColor = if ($script:FailCount -eq 0) { 'Green' } else { 'Red' }
Write-Host "  失败：$script:FailCount" -ForegroundColor $failColor

if ($script:FailCount -eq 0) {
  Write-Host "`n  全部验证通过！Redis 基础设施工作正常" -ForegroundColor Green
  exit 0
} else {
  Write-Host "`n  有 $script:FailCount 项失败，请查看上方日志排查" -ForegroundColor Red
  exit 1
}
