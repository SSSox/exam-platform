# Checks the code signature of the files SignPath returned and puts them over the unsigned ones. Every file is checked
# before the first copy, so a bad result leaves the unsigned build whole. -TestCertificate accepts SignPath's test
# certificate (a policy other than release-signing), which Windows does not trust.
param(
    [Parameter(Mandatory = $true)][string]$SignedRoot,
    [Parameter(Mandatory = $true)][string]$TargetRoot,
    [switch]$TestCertificate
)
$ErrorActionPreference = 'Stop'
$signedRoot = (Resolve-Path -LiteralPath $SignedRoot).Path.TrimEnd('\')
$targetRoot = (Resolve-Path -LiteralPath $TargetRoot).Path.TrimEnd('\')
$files = @(Get-ChildItem -LiteralPath $signedRoot -File -Recurse)
if (!$files.Count) { throw "No signed files in $signedRoot." }
foreach ($file in $files) {
    $relative = $file.FullName.Substring($signedRoot.Length + 1)
    if (!(Test-Path -LiteralPath (Join-Path $targetRoot $relative) -PathType Leaf)) { throw "Signed file has no unsigned original: $relative" }
    $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
    if (!$signature.SignerCertificate) { throw "Not signed: $relative" }
    if (!$TestCertificate -and ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'SignPath Foundation')) {
        throw "Unexpected signature on ${relative}: $($signature.Status), $($signature.SignerCertificate.Subject)"
    }
}
foreach ($file in $files) {
    $target = Join-Path $targetRoot $file.FullName.Substring($signedRoot.Length + 1)
    Copy-Item -LiteralPath $file.FullName -Destination $target -Force
    Write-Output "Signed: $target"
}
