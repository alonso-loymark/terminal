param(
  # Only items whose original folder is exactly this one (the e2e's own temp folder) are touched.
  [Parameter(Mandatory)][string]$Folder,
  [switch]$Purge
)
# Proves that a file deleted by the e2e went to the Recycle Bin (not deleted for good), then
# removes it from there so the user's Recycle Bin keeps no test leftovers.
$ErrorActionPreference = 'Stop'
$bin = (New-Object -ComObject Shell.Application).Namespace(10)
$target = $Folder.TrimEnd('\')
$found = @($bin.Items() | Where-Object { $bin.GetDetailsOf($_, 1).TrimEnd('\') -eq $target })
foreach ($item in $found) {
  if ($Purge) {
    # $R... holds the data, $I... the metadata (original path): remove both.
    $data = $item.Path
    $meta = Join-Path (Split-Path $data) ('$I' + (Split-Path $data -Leaf).Substring(2))
    Remove-Item -LiteralPath $data -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $meta -Force -ErrorAction SilentlyContinue
  }
}
$found.Count
