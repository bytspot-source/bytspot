# Launch web, auth, venue, and bff each in its own PowerShell window
param(
  [string]$Root = (Split-Path -Parent $MyInvocation.MyCommand.Path)
)

$repo = Resolve-Path "$Root\.."

function Start-Panel($name, $cmd) {
  Start-Process -FilePath "powershell" -ArgumentList "-NoExit", "-Command", $cmd -WorkingDirectory $repo
  Write-Host "Launched $name"
}

Start-Panel "WEB"   "npm run dev:web"
Start-Panel "AUTH"  "npm run dev:auth"
Start-Panel "VENUE" "npm run dev:venue"
Start-Panel "BFF"   "npm run dev:bff"

