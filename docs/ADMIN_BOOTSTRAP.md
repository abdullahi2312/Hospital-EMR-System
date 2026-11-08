# First Admin Account Bootstrap

The private one-time bootstrap uses the existing `User` model and `createUser()` service. It stores the supplied email in the existing `username` field, normalized with trim and lowercase to match login. The display name is derived from the email's local part. The account is created with role `admin` and `isActive: true`; its password is processed by the same bcrypt hashing and validation used by normal account creation. Supply an account email at runtime; this guide contains no account-specific address.

The script never reads `.env` or falls back to `MONGO_URI`. It requires a separate explicit URI for a local MongoDB host, an explicit development marker, and a database name that does not indicate production. It confirms the named database already exists before writing. Existing usernames are left unchanged, and rerunning is safe.

## Run from PowerShell

From the repository root, run this block. At the first prompt, enter the exact database name of the existing local development database. The script rejects production-looking names and refuses if that database is not already present. At the second prompt, enter the account password; PowerShell hides the input. The password is placed in a process environment variable only for the command and removed afterward.

```powershell
$env:HOSPITAL_EMR_BOOTSTRAP_ENV = 'development'
$databaseName = Read-Host 'Existing local development MongoDB database name'
if ($databaseName -notmatch '^[A-Za-z0-9_-]+$' -or $databaseName -match '(?i)prod|live') { throw 'Enter a non-production database name.' }
$env:HOSPITAL_EMR_BOOTSTRAP_MONGO_URI = "mongodb://127.0.0.1:27017/$databaseName"
$env:HOSPITAL_EMR_BOOTSTRAP_EMAIL = Read-Host 'Admin email'
$securePassword = Read-Host 'Admin password' -AsSecureString
$credential = [System.Management.Automation.PSCredential]::new('bootstrap', $securePassword)
$env:HOSPITAL_EMR_BOOTSTRAP_PASSWORD = $credential.GetNetworkCredential().Password
try {
    npm run admin:bootstrap
    if ($LASTEXITCODE -ne 0) { throw 'Admin bootstrap failed; see the safe error above.' }
}
finally {
    Remove-Item Env:HOSPITAL_EMR_BOOTSTRAP_ENV, Env:HOSPITAL_EMR_BOOTSTRAP_MONGO_URI, Env:HOSPITAL_EMR_BOOTSTRAP_EMAIL, Env:HOSPITAL_EMR_BOOTSTRAP_PASSWORD -ErrorAction SilentlyContinue
    Remove-Variable securePassword, credential, databaseName -ErrorAction SilentlyContinue
}
```

Log in through the existing login page/API using the normalized email entered at the prompt and the password entered at the hidden prompt. The script reports whether it created the account or found that username already present; it never prints the password. If the account already exists, its password, role, and active status are not changed.

The script does not run as part of application startup and does not add a public admin-registration API.
