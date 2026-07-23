param(
  [int]$AppPort = 8792,
  [int]$DebugPort = 9232
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$wrangler = Join-Path $projectRoot 'node_modules\.bin\wrangler.cmd'
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$runId = "{0}-{1}" -f $PID, [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$statePath = Join-Path $projectRoot ".wrangler\m2-browser-smoke-$runId"
$chromeProfile = Join-Path $projectRoot ".wrangler\m2-chrome-$runId"
$serverOut = Join-Path $statePath 'server.out.log'
$serverError = Join-Path $statePath 'server.error.log'
$script:cdpId = 0
$serverProcess = $null
$chromeProcess = $null
$socket = $null

function Wait-Http {
  param([string]$Url, [int]$Attempts = 40)
  for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
    try {
      return Invoke-RestMethod -Uri $Url -TimeoutSec 2
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }
  throw "等待服務逾時：$Url"
}

function Send-Cdp {
  param([string]$Method, [object]$Params = @{})
  $script:cdpId++
  $id = $script:cdpId
  $payload = @{ id = $id; method = $Method; params = $Params } | ConvertTo-Json -Compress -Depth 20
  $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
  $segment = [ArraySegment[byte]]::new($bytes)
  $socket.SendAsync(
    $segment,
    [Net.WebSockets.WebSocketMessageType]::Text,
    $true,
    [Threading.CancellationToken]::None
  ).GetAwaiter().GetResult()

  while ($true) {
    $buffer = New-Object byte[] 65536
    $message = [Text.StringBuilder]::new()
    do {
      $receiveSegment = [ArraySegment[byte]]::new($buffer)
      $received = $socket.ReceiveAsync(
        $receiveSegment,
        [Threading.CancellationToken]::None
      ).GetAwaiter().GetResult()
      [void]$message.Append([Text.Encoding]::UTF8.GetString($buffer, 0, $received.Count))
    } while (-not $received.EndOfMessage)
    $response = $message.ToString() | ConvertFrom-Json
    if ($response.id -eq $id) {
      if ($response.error) {
        throw "CDP $Method 失敗：$($response.error.message)"
      }
      return $response.result
    }
  }
}

function Evaluate-JavaScript {
  param([string]$Expression)
  $result = Send-Cdp -Method 'Runtime.evaluate' -Params @{
    expression = $Expression
    awaitPromise = $true
    returnByValue = $true
  }
  if ($result.exceptionDetails) {
    throw "頁面 JavaScript 失敗：$($result.exceptionDetails.text)"
  }
  return $result.result.value
}

function Login-And-ChangePassword {
  param([string]$Email, [string]$NewPassword)
  $emailJson = $Email | ConvertTo-Json -Compress
  $passwordJson = $NewPassword | ConvertTo-Json -Compress
  $expression = @"
(async () => {
  let response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({email: $emailJson, password: 'Demo1234!'})
  });
  if (!response.ok) throw new Error(await response.text());
  response = await fetch('/api/auth/change-password', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({currentPassword: 'Demo1234!', newPassword: $passwordJson})
  });
  if (!response.ok) throw new Error(await response.text());
  return 'ok';
})()
"@
  [void](Evaluate-JavaScript -Expression $expression)
  [void](Send-Cdp -Method 'Page.reload')
  Start-Sleep -Seconds 2
}

try {
  New-Item -ItemType Directory -Path $statePath -Force | Out-Null
  New-Item -ItemType Directory -Path $chromeProfile -Force | Out-Null
  $env:WRANGLER_LOG_PATH = Join-Path $statePath 'wrangler.log'
  $env:WRANGLER_REGISTRY_PATH = Join-Path $statePath 'registry'

  & $wrangler d1 migrations apply DB --local --persist-to $statePath | Out-Host
  if ($LASTEXITCODE -ne 0) { throw '套用 smoke D1 migration 失敗。' }

  $serverCommand = @(
    "`$env:WRANGLER_LOG_PATH='$($env:WRANGLER_LOG_PATH)'"
    "`$env:WRANGLER_REGISTRY_PATH='$($env:WRANGLER_REGISTRY_PATH)'"
    "Set-Location -LiteralPath '$projectRoot'"
    "& '$wrangler' pages dev dist --port $AppPort --persist-to '$statePath' --show-interactive-dev-session=false"
  ) -join '; '
  $serverProcess = Start-Process -FilePath 'pwsh.exe' `
    -ArgumentList @('-NoProfile', '-Command', $serverCommand) `
    -WorkingDirectory $projectRoot -WindowStyle Hidden `
    -RedirectStandardOutput $serverOut -RedirectStandardError $serverError -PassThru
  [void](Wait-Http -Url "http://127.0.0.1:$AppPort/api/health")

  $chromeProcess = Start-Process -FilePath $chrome -ArgumentList @(
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    "--remote-debugging-port=$DebugPort",
    '--remote-allow-origins=*',
    "--user-data-dir=$chromeProfile",
    "http://127.0.0.1:$AppPort/"
  ) -WindowStyle Hidden -PassThru
  [void](Wait-Http -Url "http://127.0.0.1:$DebugPort/json/version")
  $targets = Wait-Http -Url "http://127.0.0.1:$DebugPort/json/list"
  $target = $targets | Where-Object { $_.type -eq 'page' } | Select-Object -First 1
  if (-not $target) { throw '找不到 Chrome 頁面 target。' }

  $socket = [Net.WebSockets.ClientWebSocket]::new()
  $socket.ConnectAsync(
    [Uri]$target.webSocketDebuggerUrl,
    [Threading.CancellationToken]::None
  ).GetAwaiter().GetResult()
  [void](Send-Cdp -Method 'Runtime.enable')
  [void](Send-Cdp -Method 'Page.enable')
  Start-Sleep -Seconds 1

  Login-And-ChangePassword -Email 'admin@demo.local' -NewPassword 'AdminBrowserChanged1234!'
  $adminDom = Evaluate-JavaScript -Expression @"
({
  body: document.body.innerText,
  reminder: document.querySelector('[data-certification-id="ec-01"]')?.innerText ?? ''
})
"@
  if ($adminDom.body -notmatch '管理儀表板' -or
      $adminDom.reminder -notmatch '林家豪' -or
      $adminDom.reminder -notmatch 'GDP 藥品優良運銷規範') {
    throw "Admin 首頁未渲染 ec-01 到期提醒：$($adminDom.reminder)"
  }

  [void](Evaluate-JavaScript -Expression @"
(async () => {
  const response = await fetch('/api/auth/logout', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: '{}'
  });
  if (!response.ok) throw new Error(await response.text());
  return 'ok';
})()
"@)
  [void](Send-Cdp -Method 'Page.reload')
  Start-Sleep -Seconds 1

  Login-And-ChangePassword -Email 'chiahao.lin@demo.local' -NewPassword 'EmployeeBrowserChanged1234!'
  $employeeDom = Evaluate-JavaScript -Expression @"
({
  body: document.body.innerText,
  reminder: document.querySelector('[data-certification-id="ec-01"]')?.innerText ?? ''
})
"@
  if ($employeeDom.body -notmatch '林家豪，您好' -or
      $employeeDom.reminder -notmatch 'GDP 藥品優良運銷規範') {
    throw "Employee 首頁未渲染 ec-01 到期提醒：$($employeeDom.reminder)"
  }

  [PSCustomObject]@{
    AdminDashboard = 'PASS'
    AdminReminder = $adminDom.reminder -replace "`r?`n", ' / '
    EmployeeHome = 'PASS'
    EmployeeReminder = $employeeDom.reminder -replace "`r?`n", ' / '
  } | Format-List
} finally {
  if ($socket) {
    $socket.Dispose()
  }
  if ($chromeProcess -and -not $chromeProcess.HasExited) {
    Stop-Process -Id $chromeProcess.Id -Force -ErrorAction SilentlyContinue
  }
  if ($serverProcess -and -not $serverProcess.HasExited) {
    Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
  }
}
