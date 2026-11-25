# Guided one-command setup for femo1de/ExpenseTracker (Public GitHub Pages)
# + femo1de/ExpenseTracker-data (Private expenses JSON storage).

$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSVersion.Major -ge 7) {
  $PSNativeCommandUseErrorActionPreference = $false
}

# Ensure gh and git are on PATH (supports bundled Copilot Desktop binaries as fallback)
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  $ghDir = Get-ChildItem "$env:LOCALAPPDATA\copilot-desktop-gh-*" -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty FullName
  if ($ghDir -and (Test-Path "$ghDir\gh.exe")) {
    $env:PATH = "$ghDir;$env:PATH"
  }
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  $gitDir = Get-ChildItem "$env:LOCALAPPDATA\github-copilot-git-*" -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty FullName
  if ($gitDir -and (Test-Path "$gitDir\cmd\git.exe")) {
    $env:PATH = "$gitDir\cmd;$env:PATH"
  }
}

$ExpectedUser = "femo1de"
$AppRepo = "ExpenseTracker"
$DataRepo = "ExpenseTracker-data"

# Clear any work/session GH_TOKEN so gh CLI uses your personal femo1de login
Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:GITHUB_TOKEN -ErrorAction SilentlyContinue

Write-Host "`n=== Step 1/5: Sign in to GitHub as '$ExpectedUser' ===" -ForegroundColor Cyan

$prevPref = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$currentLogin = (& gh api user --jq ".login" 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $currentLogin) {
  $currentLogin = ""
} else {
  $currentLogin = ($currentLogin | Out-String).Trim()
}
$ErrorActionPreference = $prevPref

if ($currentLogin -ne $ExpectedUser) {
  Write-Host "Opening GitHub CLI login - please sign in with your personal '$ExpectedUser' account." -ForegroundColor Yellow
  & gh auth login -h github.com -p https -w
  if ($LASTEXITCODE -ne 0) { throw "GitHub CLI login failed." }
  $currentLogin = (& gh api user --jq ".login" | Out-String).Trim()
}

if ($currentLogin -ne $ExpectedUser) {
  throw "Signed in as '$currentLogin' instead of '$ExpectedUser'. Aborting to avoid touching the wrong account."
}
Write-Host "Signed in as '$currentLogin'." -ForegroundColor Green

Write-Host "`n=== Step 2/5: Creating GitHub repositories ===" -ForegroundColor Cyan

$ErrorActionPreference = "Continue"
& gh repo view "$ExpectedUser/$AppRepo" 2>$null | Out-Null
$appExists = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = $prevPref

if (-not $appExists) {
  Write-Host "Creating public app repo: $ExpectedUser/$AppRepo..."
  & gh repo create "$ExpectedUser/$AppRepo" --public --description "Simple mobile-friendly trip expense tracker"
  if ($LASTEXITCODE -ne 0) { throw "Failed to create $ExpectedUser/$AppRepo" }
} else {
  Write-Host "Repo $ExpectedUser/$AppRepo already exists - keeping it." -ForegroundColor Green
}

$ErrorActionPreference = "Continue"
& gh repo view "$ExpectedUser/$DataRepo" 2>$null | Out-Null
$dataExists = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = $prevPref

if (-not $dataExists) {
  Write-Host "Creating private data repo: $ExpectedUser/$DataRepo..."
  & gh repo create "$ExpectedUser/$DataRepo" --private --add-readme --description "Private JSON ledger for Trip Expenses"
  if ($LASTEXITCODE -ne 0) { throw "Failed to create $ExpectedUser/$DataRepo" }
} else {
  Write-Host "Repo $ExpectedUser/$DataRepo already exists - keeping it." -ForegroundColor Green
}

Write-Host "`n=== Step 3/5: Fine-Grained PAT for '$DataRepo' ===" -ForegroundColor Cyan
$openPatPage = Read-Host "Do you need to open GitHub to create a new Fine-Grained PAT? (y/N)"
if ($openPatPage -match '^[Yy]') {
  Write-Host "  1. Token name: ExpenseTracker Data"
  Write-Host "  2. Repository access: Only select repositories -> $ExpectedUser/$DataRepo"
  Write-Host "  3. Repository permissions -> Contents: Read and write (leave all others No access)"
  Write-Host "  4. Click 'Generate token' and copy the github_pat_... token."
  Write-Host ""
  Start-Process "https://github.com/settings/personal-access-tokens/new"
  Read-Host "Press Enter here once you have copied your Fine-Grained PAT"
}

Write-Host "`n=== Step 4/5: Encrypt PAT & generate config.js ===" -ForegroundColor Cyan
node scripts/setup-config.mjs
if ($LASTEXITCODE -ne 0) { throw "setup-config.mjs did not complete." }

Write-Host "`n=== Step 5/5: Commit, Push & Enable GitHub Pages ===" -ForegroundColor Cyan
git config user.email "$ExpectedUser@users.noreply.github.com"

$remotes = git remote
if ($remotes -notcontains "origin") {
  git remote add origin "https://github.com/$ExpectedUser/$AppRepo.git"
} else {
  git remote set-url origin "https://github.com/$ExpectedUser/$AppRepo.git"
}

git add .
$pendingChanges = git status --porcelain
if ($pendingChanges) {
  git commit -m "Deploy Trip Expenses webapp"
}

& git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push -u origin main
if ($LASTEXITCODE -ne 0) { throw "git push failed." }

Write-Host "Enabling GitHub Pages on main branch..."
$ErrorActionPreference = "Continue"
$pagesOut = (& gh api --method POST "repos/$ExpectedUser/$AppRepo/pages" -f "source[branch]=main" -f "source[path]=/" 2>&1 | Out-String)
$pagesExit = $LASTEXITCODE
$ErrorActionPreference = $prevPref
if ($pagesExit -ne 0 -and ($pagesOut -notmatch "already enabled|409")) {
  Write-Host "Could not enable Pages automatically: $pagesOut" -ForegroundColor Yellow
  Write-Host "Enable manually at: https://github.com/$ExpectedUser/$AppRepo/settings/pages"
} else {
  Write-Host "GitHub Pages enabled!" -ForegroundColor Green
}

Write-Host "`nAll done!" -ForegroundColor Green
Write-Host "  Live app URL : https://$ExpectedUser.github.io/$AppRepo/" -ForegroundColor Cyan
Write-Host "  Private data : https://github.com/$ExpectedUser/$DataRepo" -ForegroundColor Cyan
Write-Host "(GitHub Pages takes ~30-60 seconds on first deploy.)`n"
