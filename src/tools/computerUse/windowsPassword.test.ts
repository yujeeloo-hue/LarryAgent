import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

const workerFile = new URL("../../../resources/computer-use/windows-worker.ps1", import.meta.url);

function workerSource(): string {
  const lines = readFileSync(workerFile, "utf8").split(/\r?\n/);
  const start = lines.findIndex((line) => line === "$source = @'");
  const end = lines.findIndex((line, index) => index > start && line === "'@");
  assert.ok(start >= 0 && end > start);
  return lines.slice(start + 1, end).join("\n");
}

it("compiles the Windows password handoff commands and keeps the secret out of the result", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "jellybot-win-password-"));
  const cs = join(root, "worker.cs");
  const dll = join(root, "worker.dll");
  const fixture = join(root, "fixture.ps1");
  const probe = join(root, "probe.ps1");
  const psPath = (value: string) => value.replace(/'/g, "''");
  writeFileSync(cs, workerSource());
  writeFileSync(fixture, `
param([string]$Root)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$box = New-Object System.Windows.Forms.TextBox
$box.UseSystemPasswordChar = $true
$box.Location = New-Object System.Drawing.Point(12, 16)
$box.Size = New-Object System.Drawing.Size(180, 23)
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Password fixture'
$form.FormBorderStyle = 'FixedToolWindow'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(40, 40)
$form.ClientSize = New-Object System.Drawing.Size(204, 56)
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.Controls.Add($box)
$form.Show()
$form.Activate()
$box.Focus()
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class FixtureWin { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); }'
[void][FixtureWin]::SetForegroundWindow($form.Handle)
for ($i = 0; $i -lt 15; $i++) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 20 }
@{ pid = $PID; hwnd = [int64]$box.Handle } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $Root 'ready.json') -Encoding ascii
$stop = Join-Path $Root 'stop'
while (-not (Test-Path -LiteralPath $stop)) {
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 40
}
$form.Close()
`);
  writeFileSync(probe, `
$ErrorActionPreference = 'Stop'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'
function Asm([string]$name) { [Reflection.Assembly]::LoadWithPartialName($name).Location }
$cscArgs = @(
  '/nologo', '/t:library',
  ('/r:' + (Asm 'UIAutomationClient')),
  ('/r:' + (Asm 'UIAutomationTypes')),
  ('/r:' + (Asm 'WindowsBase')),
  ('/out:' + '${dll.replace(/'/g, "''")}'),
  '${cs.replace(/'/g, "''")}'
)
& $csc @cscArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Add-Type -Path '${dll.replace(/'/g, "''")}'
Add-Type -AssemblyName System.Web.Extensions
$w = [JellyBotComputerUse.Worker]
function Dict([hashtable]$pairs) {
  $d = New-Object 'System.Collections.Generic.Dictionary[string,object]'
  foreach ($key in $pairs.Keys) { $d[$key] = $pairs[$key] }
  return $d
}
function Text($value) { if ($null -eq $value) { '' } else { [string]$value } }
$secret = 'synthetic handoff secret'
$fill = $w::Dispatch('ui.fill_password', (Dict @{ token = 'missing'; password = $secret }))
$prepare = $w::Dispatch('ui.prepare_password', (Dict @{ pid = 0 }))
$discard = $w::Dispatch('ui.discard_password', (Dict @{ token = 'missing' }))
$self = ''
try { [void]$w::Dispatch('ui.prepare_password', (Dict @{ pid = [Diagnostics.Process]::GetCurrentProcess().Id })) }
catch {
  $ex = $_.Exception
  while ($ex.InnerException) { $ex = $ex.InnerException }
  $self = $ex.Message
}
$serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$payload = $serializer.Serialize($fill)
$work = '${psPath(root)}'
$liveError = ''
$liveFound = $false
$liveFilled = $false
$liveLength = 0
$liveText = ''
$liveLeaked = $false
$fixtureProc = $null
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class FixtureMsg {
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")] public static extern IntPtr SendText(IntPtr hWnd, uint msg, IntPtr wParam, StringBuilder text);
  [DllImport("user32.dll", EntryPoint = "SendMessageW")] public static extern IntPtr SendPtr(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
}
'@
  $fixtureProc = Start-Process -FilePath (Join-Path $env:WINDIR 'System32\\WindowsPowerShell\\v1.0\\powershell.exe') -ArgumentList @('-NoProfile','-Sta','-File','${psPath(fixture)}',$work) -PassThru
  $ready = Join-Path $work 'ready.json'
  $deadline = (Get-Date).AddSeconds(8)
  while (-not (Test-Path -LiteralPath $ready) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 40 }
  if (-not (Test-Path -LiteralPath $ready)) { throw 'password fixture did not start' }
  $info = Get-Content -LiteralPath $ready -Raw | ConvertFrom-Json
  $hwnd = [IntPtr][int64]$info.hwnd
  Add-Type -AssemblyName UIAutomationClient
  $element = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $bounds = $element.Current.BoundingRectangle
  $cx = [double]($bounds.X + $bounds.Width / 2)
  $cy = [double]($bounds.Y + $bounds.Height / 2)
  $hit = $w::Dispatch('ui.prepare_password', (Dict @{ pid = [int]$info.pid; x = $cx; y = $cy }))
  $token = [string]$hit['token']
  $liveFound = $token.Length -gt 0
  if (-not $liveFound) {
    $seen = $w::Dispatch('ui.hit_test', (Dict @{ x = $cx; y = $cy }))
    throw ('no password field at ' + $cx + ',' + $cy + ' password=' + $element.Current.IsPassword + ' hit=' + $serializer.Serialize($seen))
  }
  $filled = $w::Dispatch('ui.fill_password', (Dict @{ token = $token; password = $secret }))
  $liveFilled = [bool]$filled['filled']
  $liveLeaked = $serializer.Serialize($filled).Contains($secret)
  $liveLength = [int][FixtureMsg]::SendPtr($hwnd, 0x000E, [IntPtr]::Zero, [IntPtr]::Zero)
  $buf = New-Object System.Text.StringBuilder 256
  [void][FixtureMsg]::SendText($hwnd, 0x000D, [IntPtr]256, $buf)
  $liveText = $buf.ToString()
} catch {
  $liveError = $_.Exception.Message
} finally {
  $stop = Join-Path $work 'stop'
  New-Item -ItemType File -Path $stop -Force | Out-Null
  if ($fixtureProc -and -not $fixtureProc.HasExited) {
    Start-Sleep -Milliseconds 150
    if (-not $fixtureProc.HasExited) { Stop-Process -Id $fixtureProc.Id -Force }
  }
}
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$serializer.Serialize(@{
  origin = (Text ($w::WebOrigin('https://Example.test/login')))
  defaultPort = (Text ($w::WebOrigin('https://example.test:443/a')))
  port = (Text ($w::WebOrigin('https://example.test:444/a')))
  user = (Text ($w::WebOrigin('https://user:secret@example.test/')))
  http = (Text ($w::WebOrigin('http://example.test/x')))
  bad = (Text ($w::WebOrigin('not a url')))
  currentPassword = $w::PasswordLabelAllowed('password', 'Password', '', 'autocomplete=current-password')
  newPassword = $w::PasswordLabelAllowed('new-password', '', '', '')
  pin = $w::PasswordLabelAllowed('', 'PIN', '', '')
  email = $w::AccountFieldMatch('email', '', '')
  emailLabel = $w::AccountFieldMatch('', 'Email address', '')
  search = $w::AccountFieldMatch('search', 'Search', '')
  chrome = $w::TrustedBrowserPublisher('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'CN=Google LLC, O=Google LLC, L=Mountain View, S=California, C=US', $true)
  chromeUntrusted = $w::TrustedBrowserPublisher('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'O=Google LLC', $false)
  edge = $w::TrustedBrowserPublisher('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US', $true)
  other = $w::TrustedBrowserPublisher('C:\\Windows\\System32\\notepad.exe', 'O=Microsoft Corporation', $true)
  signed = $(
    $ok = $true
    $checked = 0
    foreach ($browser in @(
      'C:\Program Files\Google\Chrome\Application\chrome.exe',
      'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
    )) {
      if (Test-Path -LiteralPath $browser) {
        $checked++
        if (-not $w::AuthenticodeTrusted($browser)) { $ok = $false }
      }
    }
    $ok
  )
  checked = $(
    $n = 0
    foreach ($browser in @(
      'C:\Program Files\Google\Chrome\Application\chrome.exe',
      'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
    )) { if (Test-Path -LiteralPath $browser) { $n++ } }
    $n
  )
  unsigned = $w::AuthenticodeTrusted('${cs.replace(/'/g, "''")}')
  filled = [bool]$fill['filled']
  leaked = $payload.Contains($secret)
  prepared = [int]$prepare.Count
  discarded = [int]$discard.Count
  self = $self
  liveError = $liveError
  liveFound = $liveFound
  liveFilled = $liveFilled
  liveLength = $liveLength
  liveText = $liveText
  liveLeaked = $liveLeaked
})
`);
  try {
    const probeRun = spawnSync("powershell", ["-NoProfile", "-File", probe], { encoding: "utf8" });
    assert.equal(probeRun.status, 0, `${probeRun.stdout}\n${probeRun.stderr}`);
    const report = JSON.parse(probeRun.stdout) as Record<string, unknown>;
    assert.equal(report.origin, "https://example.test");
    assert.equal(report.defaultPort, "https://example.test");
    assert.equal(report.port, "https://example.test:444");
    assert.equal(report.user, "");
    assert.equal(report.http, "http://example.test");
    assert.equal(report.bad, "");
    assert.equal(report.currentPassword, true);
    assert.equal(report.newPassword, false);
    assert.equal(report.pin, false);
    assert.equal(report.email, true);
    assert.equal(report.emailLabel, true);
    assert.equal(report.search, false);
    assert.equal(report.chrome, true);
    assert.equal(report.chromeUntrusted, false);
    assert.equal(report.edge, true);
    assert.equal(report.other, false);
    if (Number(report.checked) > 0) assert.equal(report.signed, true);
    assert.equal(report.unsigned, false);
    assert.equal(report.filled, false);
    assert.equal(report.leaked, false);
    assert.equal(report.prepared, 0);
    assert.equal(report.discarded, 0);
    assert.match(String(report.self), /ui\.prepare_password/);
    assert.equal(report.liveError, "");
    assert.equal(report.liveFound, true);
    assert.equal(report.liveFilled, true);
    assert.equal(report.liveLeaked, false);
    assert.ok(Number(report.liveLength) > 0);
    assert.equal(report.liveText, "synthetic handoff secret");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
