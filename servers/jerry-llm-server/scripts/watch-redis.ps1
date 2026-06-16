# ==============================================================================
# Redis 实时观测面板（PowerShell 版）
# ==============================================================================
# 使用方式：
#   ./scripts/watch-redis.ps1            # 默认每 1 秒刷新一次
#   ./scripts/watch-redis.ps1 -Interval 2 # 自定义刷新间隔
#
# 显示内容：
#   - 当前所有 jerry: 业务 key 分布
#   - 限流 ZSET 当前计数 + TTL
#   - 锁 key 持有者 token + TTL
#   - 缓存 key 数量 + 平均 TTL
#   - Redis 内存占用
#
# 适用场景：
#   - 面试演示：左屏跑这个脚本，右屏发请求，让面试官看 key 实时变化
#   - 日常调优：观察 key 是否符合预期
# ==============================================================================

param(
  [int]    $Interval  = 1,
  [string] $Container = 'jerry-redis',
  [string] $Prefix    = 'jerry:'
)

function Invoke-Redis {
  param([string[]] $Args)
  return docker exec $Container redis-cli @Args 2>$null
}

while ($true) {
  Clear-Host
  $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Write-Host "Redis 实时观测面板  [$timestamp]" -ForegroundColor Cyan
  Write-Host ('=' * 70) -ForegroundColor Cyan

  # ==== 1. 业务 key 分布 ====
  Write-Host "`n📦 业务 Key 分布（$Prefix*）" -ForegroundColor Yellow
  $allKeys = Invoke-Redis -Args @('KEYS', "$Prefix*")
  if ($allKeys) {
    $byNamespace = @{}
    $allKeys | ForEach-Object {
      $parts = $_ -split ':'
      if ($parts.Length -ge 2) {
        $ns = $parts[1]
        if ($parts.Length -ge 3) { $ns = "$ns`:$($parts[2])" }
        if (-not $byNamespace.ContainsKey($ns)) { $byNamespace[$ns] = 0 }
        $byNamespace[$ns]++
      }
    }
    $byNamespace.GetEnumerator() | Sort-Object Name | ForEach-Object {
      $line = "  {0,-30} {1,5} 个" -f "$Prefix$($_.Key):*", $_.Value
      Write-Host $line -ForegroundColor Green
    }
  } else {
    Write-Host '  （空）' -ForegroundColor Gray
  }

  # ==== 2. 限流 ZSET ====
  Write-Host "`n🚦 限流（rate-limit:chat:*）" -ForegroundColor Yellow
  $rateKeys = Invoke-Redis -Args @('KEYS', "${Prefix}rate-limit:chat:*")
  if ($rateKeys) {
    foreach ($k in ($rateKeys | Select-Object -First 10)) {
      $count = Invoke-Redis -Args @('ZCARD', $k)
      $ttl   = Invoke-Redis -Args @('TTL', $k)
      $subject = ($k -replace "${Prefix}rate-limit:chat:", '')
      Write-Host ("  {0,-30}  请求数={1,-3}  TTL={2}s" -f $subject, $count, $ttl)
    }
    if ($rateKeys.Count -gt 10) {
      Write-Host "  ... 还有 $($rateKeys.Count - 10) 个" -ForegroundColor Gray
    }
  } else {
    Write-Host '  （无限流记录）' -ForegroundColor Gray
  }

  # ==== 3. 分布式锁 ====
  Write-Host "`n🔒 分布式锁（lock:*）" -ForegroundColor Yellow
  $lockKeys = Invoke-Redis -Args @('KEYS', "${Prefix}lock:*")
  if ($lockKeys) {
    foreach ($k in $lockKeys) {
      $token = Invoke-Redis -Args @('GET', $k)
      $ttl   = Invoke-Redis -Args @('TTL', $k)
      $shortToken = if ($token -and $token.Length -gt 16) { $token.Substring(0,16) + '...' } else { $token }
      $name = ($k -replace "${Prefix}lock:", '')
      Write-Host ("  {0,-40}  TTL={1}s  token={2}" -f $name, $ttl, $shortToken) -ForegroundColor Magenta
    }
  } else {
    Write-Host '  （无活动锁）' -ForegroundColor Gray
  }

  # ==== 4. 缓存 ====
  Write-Host "`n💾 缓存（session-asset:*）" -ForegroundColor Yellow
  $cacheKeys = Invoke-Redis -Args @('KEYS', "${Prefix}session-asset:*")
  if ($cacheKeys) {
    Write-Host "  共 $($cacheKeys.Count) 个会话资产缓存"
    # 取前 5 个看 TTL
    foreach ($k in ($cacheKeys | Select-Object -First 5)) {
      $ttl = Invoke-Redis -Args @('TTL', $k)
      $sid = ($k -replace "${Prefix}session-asset:", '')
      $shortSid = if ($sid.Length -gt 32) { $sid.Substring(0,32) + '...' } else { $sid }
      Write-Host ("  {0,-40}  TTL={1}s" -f $shortSid, $ttl) -ForegroundColor Cyan
    }
    if ($cacheKeys.Count -gt 5) {
      Write-Host "  ... 还有 $($cacheKeys.Count - 5) 个" -ForegroundColor Gray
    }
  } else {
    Write-Host '  （无缓存记录）' -ForegroundColor Gray
  }

  # ==== 5. Redis 状态 ====
  Write-Host "`n📊 Redis 状态" -ForegroundColor Yellow
  $info = Invoke-Redis -Args @('INFO', 'memory')
  $memUsed = ($info -split "`n") | Where-Object { $_ -like 'used_memory_human*' }
  $memPeak = ($info -split "`n") | Where-Object { $_ -like 'used_memory_peak_human*' }
  $dbsize = Invoke-Redis -Args @('DBSIZE')
  Write-Host "  $memUsed".Trim()
  Write-Host "  $memPeak".Trim()
  Write-Host "  total_keys: $dbsize"

  Write-Host "`n----------------------------------------------------------------------" -ForegroundColor DarkGray
  Write-Host "  按 Ctrl+C 退出 | 刷新间隔 ${Interval}s" -ForegroundColor DarkGray

  Start-Sleep -Seconds $Interval
}
