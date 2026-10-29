param(
    [Parameter(Mandatory=$true)][string]$Exe,
    [string]$SeedDirectory = '',
    [switch]$SeedClientAccount
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
Add-Type -AssemblyName System.Web.Extensions
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('sakura-account-storage-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($scratch) | Out-Null
$assembly = [Reflection.Assembly]::LoadFile([IO.Path]::GetFullPath($Exe))
$flags = [Reflection.BindingFlags]'Instance,Public,NonPublic'
$optionsType = $assembly.GetType('SakuraCode.Desktop.Options', $true)
$windowType = $assembly.GetType('SakuraCode.Desktop.DesktopWindow', $true)
$options = [Activator]::CreateInstance($optionsType, $true)
$optionsType.GetField('DataDir', $flags).SetValue($options, $scratch)
# Exercise the compiled persistence/load/acknowledgement without opening a GUI.
$window = [Runtime.Serialization.FormatterServices]::GetUninitializedObject($windowType)
$stream = New-Object IO.MemoryStream
$writer = New-Object IO.StreamWriter($stream, (New-Object Text.UTF8Encoding($false)))
$writer.AutoFlush = $true
$windowType.GetField('options', $flags).SetValue($window, $options)
$windowType.GetField('settingsLock', $flags).SetValue($window, (New-Object Object))
$windowType.GetField('logLock', $flags).SetValue($window, (New-Object Object))
$windowType.GetField('activeSecret', $flags).SetValue($window, '')
$windowType.GetField('engineInput', $flags).SetValue($window, $writer)
$persist = $windowType.GetMethod('PersistAccountFrame', $flags)
$load = $windowType.GetMethod('LoadAccountSettings', $flags)
$credentials = New-Object 'Collections.Generic.Dictionary[string,object]'
$credentials.Add('apiKey', 'sk-SYNTHETIC_SAKURA_AUTHORIZED_KEY')
$credentials.Add('keyName', 'SYNTHETIC_DESKTOP_AUTHORIZATION')
$credentials.Add('model', 'gpt-test')
$frame = New-Object 'Collections.Generic.Dictionary[string,object]'
$frame.Add('id', 'synthetic-storage-test'); $frame.Add('settings', $credentials)
$file = Join-Path $scratch 'sakuraapi.json'
function Invoke-Persistence {
    $stream.SetLength(0); $stream.Position = 0
    # Match the actual engine's JSON pipe: unwrap every nested PowerShell
    # PSObject by decoding the wire JSON in the same native serializer.
    $wireSerializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $wireFrame = $wireSerializer.DeserializeObject((ConvertTo-Json -InputObject $frame -Depth 16 -Compress))
    $persist.Invoke($window, [object[]]@($wireFrame.PSObject.BaseObject)) | Out-Null
    $ack = [Text.Encoding]::UTF8.GetString($stream.ToArray()) | ConvertFrom-Json
    if ($ack.type -ne 'desktop/sakuraapi/saved' -or $ack.id -ne $frame['id']) { throw 'Invalid persistence acknowledgement' }
    return $ack.ok
}
try {
    if (!(Invoke-Persistence)) { throw 'Compiled Key persistence failed' }
    $text = [IO.File]::ReadAllText($file)
    if ($text.Contains('sk-SYNTHETIC') -or $text.Contains('SYNTHETIC_DESKTOP_AUTHORIZATION')) { throw 'Key persisted in plaintext' }
    $envelope = $text | ConvertFrom-Json
    if (!$envelope.protectedSettings) { throw 'Missing encrypted Key envelope' }
    $plain = [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($envelope.protectedSettings), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)) | ConvertFrom-Json
    if ($plain.apiKey -ne $credentials['apiKey'] -or $plain.model -ne 'gpt-test') { throw 'DPAPI Key round trip failed' }
    $loaded = $load.Invoke($window, [object[]]@())
    if ($loaded['apiKey'] -ne $credentials['apiKey'] -or $loaded['keyName'] -ne $credentials['keyName']) { throw 'Compiled Key load failed' }
    if ($SeedDirectory -and !$SeedClientAccount) {
        # Only the opt-in desktop smoke's isolated temporary directory may be seeded.
        $seed = [IO.Path]::GetFullPath($SeedDirectory)
        $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
        if (!$seed.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase) -or $seed.Substring($temp.Length) -notmatch '^sakura-desktop-smoke-[^\\]+\\desktop data$') { throw 'Seed directory must be an isolated desktop smoke directory' }
        [IO.Directory]::CreateDirectory($seed) | Out-Null
        [IO.File]::Copy($file, (Join-Path $seed 'sakuraapi.json'), $false)
    }
    $frame['settings'] = $null
    $held = New-Object IO.FileStream($file, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if (Invoke-Persistence) { throw 'Locked Key deletion was falsely acknowledged' }
        if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw 'Locked Key unexpectedly disappeared' }
    } finally { $held.Dispose() }
    if (!(Invoke-Persistence)) { throw 'Key removal was not acknowledged' }
    if (Test-Path -LiteralPath $file) { throw 'Logout did not remove encrypted Key file' }
    # The same envelope must protect both the independent account session and
    # a separately selected inference Key, including rotated-token rollback.
    $client = New-Object 'Collections.Generic.Dictionary[string,object]'
    $user = New-Object 'Collections.Generic.Dictionary[string,object]'
    $user.Add('id', 73); $user.Add('username', '<img src=x> Sakura client'); $user.Add('email', 'synthetic@example.test')
    $client.Add('clientId', 'sakuracode'); $client.Add('scope', 'account:read keys:read keys:create usage:read')
    $client.Add('accessToken', 'SYNTHETIC_CLIENT_ACCESS_TOKEN'); $client.Add('refreshToken', ('rt_' + ('a' * 64)))
    $client.Add('accessExpiresAt', 0); $client.Add('idleTimeoutSeconds', 432000); $client.Add('idleExpiresAt', '2099-01-01T00:00:00Z'); $client.Add('user', $user)
    $clientCredentials = New-Object 'Collections.Generic.Dictionary[string,object]'
    $clientCredentials.Add('client', $client); $frame['settings'] = $clientCredentials
    if (!(Invoke-Persistence)) { throw 'Client-account-only save failed' }
    $loadedClient = $load.Invoke($window, [object[]]@())
    if ($loadedClient.ContainsKey('apiKey') -or $loadedClient['client']['refreshToken'] -ne $client['refreshToken']) { throw 'Account connection manufactured a Key or lost tokens' }
    $clientCredentials.Add('apiKey', $credentials['apiKey']); $clientCredentials.Add('keyId', 101)
    $clientCredentials.Add('keyName', $credentials['keyName']); $clientCredentials.Add('model', 'gpt-test')
    if (!(Invoke-Persistence)) { throw 'Client account + selected Key save failed' }
    $beforeRotation = [IO.File]::ReadAllText($file)
    $client['accessToken'] = 'SYNTHETIC_CLIENT_ROTATED_ACCESS_TOKEN'; $client['refreshToken'] = ('rt_' + ('b' * 64))
    $client['accessExpiresAt'] = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 3600000)
    $heldRotation = New-Object IO.FileStream($file, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if (Invoke-Persistence) { throw 'Locked client rotation falsely acknowledged' }
        if ([IO.File]::ReadAllText($file) -ne $beforeRotation) { throw 'Failed client rotation destroyed old encrypted credentials' }
    } finally { $heldRotation.Dispose() }
    if (!(Invoke-Persistence)) { throw 'Explicit client rotation save retry failed' }
    $loadedClient = $load.Invoke($window, [object[]]@())
    if ($loadedClient['client']['refreshToken'] -ne $client['refreshToken'] -or $loadedClient['apiKey'] -ne $credentials['apiKey'] -or $loadedClient['keyId'] -ne 101) { throw 'Rotated client + separate Key round trip failed' }
    $clientText = [IO.File]::ReadAllText($file)
    foreach ($secret in @($credentials['apiKey'], $client['accessToken'], $client['refreshToken'], $user['email'])) { if ($clientText.Contains($secret)) { throw 'Client-account credential persisted in plaintext' } }
    $redact = $windowType.GetMethod('Redact', $flags)
    $redacted = $redact.Invoke($window, [object[]]@('SYNTHETIC_CLIENT_ACCESS_TOKEN ' + $client['accessToken'] + ' ' + $client['refreshToken'] + ' ' + $credentials['apiKey']))
    if ($redacted.Contains('TOKEN') -or $redacted.Contains('rt_') -or $redacted.Contains('sk-SYNTHETIC')) { throw 'Client-account logs failed to redact old/new tokens and inference Key' }
    if ($SeedDirectory -and $SeedClientAccount) {
        $seed = [IO.Path]::GetFullPath($SeedDirectory)
        $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
        if (!$seed.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase) -or $seed.Substring($temp.Length) -notmatch '^sakura-desktop-smoke-[^\\]+\\desktop data$') { throw 'Client seed must be an isolated desktop smoke directory' }
        [IO.Directory]::CreateDirectory($seed) | Out-Null
        # Start with the initial session to exercise transparent rotation in SEA.
        $client['accessToken'] = 'SYNTHETIC_CLIENT_ACCESS_TOKEN'; $client['refreshToken'] = ('rt_' + ('a' * 64)); $client['accessExpiresAt'] = 0
        if (!(Invoke-Persistence)) { throw 'Client smoke seed save failed' }
        [IO.File]::Copy($file, (Join-Path $seed 'sakuraapi.json'), $false)
    }
    $frame['settings'] = $null
    if (!(Invoke-Persistence) -or (Test-Path -LiteralPath $file)) { throw 'Client-account logout did not remove full encrypted envelope' }
    Write-Output 'Compiled client-account/selected-Key DPAPI save/load/rotation rollback/logout and log redaction PASS (synthetic credentials only)'
    [IO.Directory]::CreateDirectory($file) | Out-Null
    $frame['settings'] = $credentials
    if (Invoke-Persistence) { throw 'Failed Key storage was falsely acknowledged' }
    # The same compiled launcher also acknowledges the context viewer's
    # non-secret settings transaction only after an actual disk save.
    $contextPersist = $windowType.GetMethod('PersistContextSettingsFrame', $flags)
    $budget = New-Object 'Collections.Generic.Dictionary[string,object]'
    $budget.Add('contextWindowTokens', 128000); $budget.Add('thresholdPercent', 70); $budget.Add('autoThreshold', 0)
    $pref = New-Object 'Collections.Generic.Dictionary[string,object]'
    $pref.Add('contextBudget', $budget)
    $prefMap = New-Object 'Collections.Generic.Dictionary[string,object]'
    $prefMap.Add($scratch, $pref)
    $contextSettings = New-Object 'Collections.Generic.Dictionary[string,object]'
    $contextSettings.Add('workspace', $scratch)
    $contextSettings.Add('recentWorkspaces', [object[]]@($scratch))
    $contextSettings.Add('workspacePrefs', $prefMap)
    $contextFrame = New-Object 'Collections.Generic.Dictionary[string,object]'
    $contextFrame.Add('id', 'synthetic-context-save'); $contextFrame.Add('settings', $contextSettings)
    function Invoke-ContextPersistence {
        $wireSerializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
        $wire = $wireSerializer.Deserialize((ConvertTo-Json -InputObject $contextFrame -Depth 16 -Compress), [Collections.Generic.Dictionary[string,object]])
        $contextPersist.Invoke($window, [object[]]@($wire.PSObject.BaseObject)) | Out-Null
    }
    $stream.SetLength(0); $stream.Position = 0
    Invoke-ContextPersistence
    $contextAck = [Text.Encoding]::UTF8.GetString($stream.ToArray()) | ConvertFrom-Json
    if ($contextAck.type -ne 'desktop/context-settings/saved' -or $contextAck.id -ne 'synthetic-context-save' -or !$contextAck.ok) { throw 'Context settings were not acknowledged' }
    $contextFile = Join-Path $scratch 'settings.json'
    $savedContext = [IO.File]::ReadAllText($contextFile) | ConvertFrom-Json
    $savedBudget = $savedContext.WorkspacePrefs.PSObject.Properties[$scratch].Value.contextBudget
    if ($savedBudget.contextWindowTokens -ne 128000 -or $savedBudget.thresholdPercent -ne 70 -or $savedBudget.autoThreshold -ne 0) { throw 'Context thresholds were not saved to disk' }
    $heldContext = New-Object IO.FileStream($contextFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $budget['thresholdPercent'] = 60
        $stream.SetLength(0); $stream.Position = 0
        Invoke-ContextPersistence
        $failedContextAck = [Text.Encoding]::UTF8.GetString($stream.ToArray()) | ConvertFrom-Json
        if ($failedContextAck.type -ne 'desktop/context-settings/saved' -or $failedContextAck.ok) { throw 'Locked context settings were falsely acknowledged' }
        $unchanged = [IO.File]::ReadAllText($contextFile) | ConvertFrom-Json
        if ($unchanged.WorkspacePrefs.PSObject.Properties[$scratch].Value.contextBudget.thresholdPercent -ne 70) { throw 'Failed context save changed persisted thresholds' }
    } finally { $heldContext.Dispose() }
    # Appearance changes merge only one non-secret field into the latest settings.
    # Preserve real storage behavior for obsolete model fields and other accounts.
    Add-Type -AssemblyName System.Web.Extensions
    $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $settingsType = $assembly.GetType('SakuraCode.Desktop.DesktopSettings', $true)
    $current = $serializer.Deserialize([IO.File]::ReadAllText($contextFile), $settingsType)
    foreach ($entry in @{
        BaseUrl = 'https://synthetic-legacy.example/v1'; Model = 'synthetic-legacy-model';
        ProtectedApiKey = 'SYNTHETIC_LEGACY_CIPHERTEXT'; RememberKey = $true;
        NewWorkspaceDir = (Join-Path $scratch 'projects')
    }.GetEnumerator()) { $settingsType.GetProperty($entry.Key).SetValue($current, $entry.Value, $null) }
    $windowType.GetField('settings', $flags).SetValue($window, $current)
    [IO.File]::WriteAllText($contextFile, $serializer.Serialize($current))
    Remove-Item -LiteralPath $file -Recurse -Force
    [IO.File]::WriteAllText($file, $text)
    $weixinFile = Join-Path $scratch 'weixin.json'
    $weixinCipher = [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes('{"token":"SYNTHETIC_WEIXIN_TOKEN"}'), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))
    [IO.File]::WriteAllText($weixinFile, ($serializer.Serialize(@{protectedSettings=$weixinCipher})))
    $keyHash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
    $weixinHash = (Get-FileHash -LiteralPath $weixinFile -Algorithm SHA256).Hash
    $appearancePersist = $windowType.GetMethod('PersistAppearanceFrame', $flags)
    $display = New-Object 'Collections.Generic.Dictionary[string,object]'
    $display.Add('quotaDisplay', 'always')
    $displayFrame = New-Object 'Collections.Generic.Dictionary[string,object]'
    $displayFrame.Add('id', 'synthetic-appearance-save'); $displayFrame.Add('settings', $display)
    function Invoke-AppearancePersistence {
        $stream.SetLength(0); $stream.Position = 0
        $appearancePersist.Invoke($window, [object[]]@($displayFrame.PSObject.BaseObject)) | Out-Null
        $ack = [Text.Encoding]::UTF8.GetString($stream.ToArray()) | ConvertFrom-Json
        if ($ack.type -ne 'desktop/appearance/saved' -or $ack.id -ne $displayFrame['id']) { throw 'Invalid appearance acknowledgement' }
        return $ack.ok
    }
    foreach ($mode in @('always', 'hover', 'settings')) {
        $display['quotaDisplay'] = $mode
        if (!(Invoke-AppearancePersistence)) { throw 'Compiled appearance storage failed' }
        $saved = [IO.File]::ReadAllText($contextFile) | ConvertFrom-Json
        if ($saved.Appearance.quotaDisplay -ne $mode) { throw 'Appearance mode not saved' }
        if ($saved.BaseUrl -ne 'https://synthetic-legacy.example/v1' -or $saved.Model -ne 'synthetic-legacy-model' -or $saved.ProtectedApiKey -ne 'SYNTHETIC_LEGACY_CIPHERTEXT' -or !$saved.RememberKey) { throw 'Appearance save destroyed legacy credentials' }
        if ($saved.NewWorkspaceDir -ne (Join-Path $scratch 'projects') -or $saved.WorkspacePrefs.PSObject.Properties[$scratch].Value.contextBudget.thresholdPercent -ne 70) { throw 'Appearance save destroyed workspace/context prefs' }
        $windowType.GetMethod('LoadSettings', $flags).Invoke($window, [object[]]@()) | Out-Null
        if ($windowType.GetField('settings', $flags).GetValue($window).Appearance['quotaDisplay'] -ne $mode) { throw 'Compiled mode restart load failed' }
    }
    $unchangedDisplay = [IO.File]::ReadAllText($contextFile)
    foreach ($invalid in @('', 'never', 123, @('hover'))) {
        $display['quotaDisplay'] = $invalid
        if (Invoke-AppearancePersistence) { throw 'Invalid appearance was falsely acknowledged' }
        if ([IO.File]::ReadAllText($contextFile) -ne $unchangedDisplay) { throw 'Invalid appearance modified settings' }
    }
    $display['quotaDisplay'] = 'hover'; $display.Add('apiKey', 'SYNTHETIC_UNRELATED')
    if (Invoke-AppearancePersistence) { throw 'Mixed appearance fields were accepted' }
    $display.Remove('apiKey') | Out-Null
    $heldDisplay = New-Object IO.FileStream($contextFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if (Invoke-AppearancePersistence) { throw 'Locked appearance save was falsely acknowledged' }
        if ([IO.File]::ReadAllText($contextFile) -ne $unchangedDisplay) { throw 'Failed appearance save changed disk settings' }
        if ($windowType.GetField('settings', $flags).GetValue($window).Appearance['quotaDisplay'] -ne 'settings') { throw 'Failed appearance changed live launcher settings' }
    } finally { $heldDisplay.Dispose() }
    if (!(Invoke-AppearancePersistence)) { throw 'Appearance retry failed' }
    # Context/full workspace frames may contain a stale appearance: they cannot replace it.
    $budget['thresholdPercent'] = 70
    $stale = New-Object 'Collections.Generic.Dictionary[string,object]'; $stale.Add('quotaDisplay', 'always')
    $contextSettings.Add('appearance', $stale)
    $stream.SetLength(0); $stream.Position = 0
    Invoke-ContextPersistence
    $saved = [IO.File]::ReadAllText($contextFile) | ConvertFrom-Json
    if ($saved.Appearance.quotaDisplay -ne 'hover') { throw 'Stale context save overwrote latest appearance' }
    $windowType.GetMethod('LoadSettings', $flags).Invoke($window, [object[]]@()) | Out-Null
    if ($windowType.GetField('settings', $flags).GetValue($window).Appearance['quotaDisplay'] -ne 'hover') { throw 'Compiled appearance restart load failed' }
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $keyHash -or (Get-FileHash -LiteralPath $weixinFile -Algorithm SHA256).Hash -ne $weixinHash) { throw 'Appearance save modified account credentials' }
    if ([IO.File]::ReadAllText($contextFile).Contains('sk-SYNTHETIC')) { throw 'Appearance leaked the authorized Key' }
    $invalidSaved = [IO.File]::ReadAllText($contextFile) | ConvertFrom-Json
    $invalidSaved.Appearance.quotaDisplay = 'never'
    [IO.File]::WriteAllText($contextFile, ($invalidSaved | ConvertTo-Json -Depth 10))
    $windowType.GetMethod('LoadSettings', $flags).Invoke($window, [object[]]@()) | Out-Null
    if ($null -ne $windowType.GetField('settings', $flags).GetValue($window).Appearance) { throw 'Invalid saved appearance did not fall back to defaults' }
    $retryPersist = $windowType.GetMethod('PersistRetryFrame', $flags)
    $retryPolicy = New-Object 'Collections.Generic.Dictionary[string,object]'
    $retryPolicy.Add('enabled', $true); $retryPolicy.Add('windowMs', 60000); $retryPolicy.Add('maxRetries', 3); $retryPolicy.Add('delayMs', 2000)
    $retryFrame = New-Object 'Collections.Generic.Dictionary[string,object]'
    $retryFrame.Add('id', 'synthetic-retry-save'); $retryFrame.Add('settings', $retryPolicy)
    function Invoke-RetryPersistence {
        $stream.SetLength(0); $stream.Position = 0
        $retryPersist.Invoke($window, [object[]]@($retryFrame.PSObject.BaseObject)) | Out-Null
        $ack = [Text.Encoding]::UTF8.GetString($stream.ToArray()) | ConvertFrom-Json
        if ($ack.type -ne 'desktop/retry/saved' -or $ack.id -ne $retryFrame['id']) { throw 'Invalid retry acknowledgement' }
        return $ack.ok
    }
    if (!(Invoke-RetryPersistence)) { throw 'Compiled retry policy save failed' }
    $retryText = [IO.File]::ReadAllText($contextFile)
    $retrySettings = $retryText | ConvertFrom-Json
    if ($retrySettings.Retry.maxRetries -ne 3 -or $retrySettings.Retry.windowMs -ne 60000) { throw 'Retry policy not saved' }
    if ($retrySettings.ProtectedApiKey -ne 'SYNTHETIC_LEGACY_CIPHERTEXT' -or $retrySettings.WorkspacePrefs.PSObject.Properties[$scratch].Value.contextBudget.thresholdPercent -ne 70) { throw 'Retry save modified credentials/context' }
    $windowType.GetMethod('LoadSettings', $flags).Invoke($window, [object[]]@()) | Out-Null
    if ($windowType.GetField('settings', $flags).GetValue($window).Retry['maxRetries'] -ne 3) { throw 'Retry policy restart load failed' }
    $retryPolicy['maxRetries'] = 5
    $heldRetry = New-Object IO.FileStream($contextFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if (Invoke-RetryPersistence) { throw 'Locked retry save was falsely acknowledged' }
        if ([IO.File]::ReadAllText($contextFile) -ne $retryText) { throw 'Failed retry save changed disk state' }
        if ($windowType.GetField('settings', $flags).GetValue($window).Retry['maxRetries'] -ne 3) { throw 'Failed retry changed launcher state' }
    } finally { $heldRetry.Dispose() }
    foreach ($invalid in @(-1, 21, 1.5, '3', $null)) {
        $retryPolicy['maxRetries'] = $invalid
        if (Invoke-RetryPersistence) { throw 'Invalid retry count accepted' }
    }
    $retryPolicy['maxRetries'] = 5
    if (!(Invoke-RetryPersistence)) { throw 'Explicit retry policy save did not recover' }
    $display['quotaDisplay'] = 'hover'
    if (!(Invoke-AppearancePersistence)) { throw 'Appearance save failed after retry save' }
    Invoke-ContextPersistence
    if (([IO.File]::ReadAllText($contextFile) | ConvertFrom-Json).Retry.maxRetries -ne 5) { throw 'Stale appearance/context save overwrote retry policy' }
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $keyHash -or (Get-FileHash -LiteralPath $weixinFile -Algorithm SHA256).Hash -ne $weixinHash) { throw 'Retry save modified encrypted accounts' }
    # Update preferences are a dedicated acknowledged transaction. Stale model,
    # context, display and retry frames must never replace the chosen source.
    $updatesPersist = $windowType.GetMethod('PersistUpdatesFrame', $flags)
    $updates = New-Object 'Collections.Generic.Dictionary[string,object]'
    $updates.Add('feedUrl', 'https://updates.example.test/sakuracode/latest.json'); $updates.Add('autoCheck', $false)
    $updatesFrame = New-Object 'Collections.Generic.Dictionary[string,object]'
    $updatesFrame.Add('id', 'synthetic-update-source-save'); $updatesFrame.Add('settings', $updates)
    function Invoke-UpdatesPersistence {
        $stream.SetLength(0); $stream.Position = 0
        $wire = $serializer.DeserializeObject((ConvertTo-Json -InputObject $updatesFrame -Depth 16 -Compress))
        $updatesPersist.Invoke($window, [object[]]@($wire.PSObject.BaseObject)) | Out-Null
        $ack = [Text.Encoding]::UTF8.GetString($stream.ToArray()) | ConvertFrom-Json
        if ($ack.type -ne 'desktop/updates/saved' -or $ack.id -ne $updatesFrame['id']) { throw 'Invalid update settings acknowledgement' }
        return $ack.ok
    }
    if (!(Invoke-UpdatesPersistence)) { throw 'Compiled update source persistence failed' }
    $updatesText = [IO.File]::ReadAllText($contextFile)
    $savedUpdates = $updatesText | ConvertFrom-Json
    if ($savedUpdates.Updates.feedUrl -ne $updates['feedUrl'] -or $savedUpdates.Updates.autoCheck) { throw 'Wrong persisted update source' }
    if ($savedUpdates.ProtectedApiKey -ne 'SYNTHETIC_LEGACY_CIPHERTEXT' -or $savedUpdates.Appearance.quotaDisplay -ne 'hover' -or $savedUpdates.Retry.maxRetries -ne 5 -or $savedUpdates.WorkspacePrefs.PSObject.Properties[$scratch].Value.contextBudget.thresholdPercent -ne 70) { throw 'Update source save changed credentials/appearance/retry/context' }
    $windowType.GetMethod('LoadSettings', $flags).Invoke($window, [object[]]@()) | Out-Null
    if ($windowType.GetField('settings', $flags).GetValue($window).Updates['feedUrl'] -ne $updates['feedUrl']) { throw 'Compiled update source restart load failed' }
    $updates['feedUrl'] = 'https://changed.example.test/latest.json'
    $heldUpdates = New-Object IO.FileStream($contextFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if (Invoke-UpdatesPersistence) { throw 'Locked update source save was falsely acknowledged' }
        if ([IO.File]::ReadAllText($contextFile) -ne $updatesText) { throw 'Failed update source save changed disk state' }
        if ($windowType.GetField('settings', $flags).GetValue($window).Updates['feedUrl'] -ne $savedUpdates.Updates.feedUrl) { throw 'Failed update source save changed native state' }
    } finally { $heldUpdates.Dispose() }
    foreach ($invalid in @('http://external.example/latest.json', 'https://user:secret@example.test/latest.json', 'https://example.test/latest.json?token=secret', 'javascript:alert(1)')) {
        $updates['feedUrl'] = $invalid
        if (Invoke-UpdatesPersistence) { throw 'Unsafe update source accepted by native storage' }
    }
    $updates['feedUrl'] = $savedUpdates.Updates.feedUrl
    if (!(Invoke-UpdatesPersistence)) { throw 'Explicit update source save retry failed' }
    if (!(Invoke-AppearancePersistence) -or !(Invoke-RetryPersistence)) { throw 'Display/retry save failed after update source save' }
    Invoke-ContextPersistence
    if (([IO.File]::ReadAllText($contextFile) | ConvertFrom-Json).Updates.feedUrl -ne $updates['feedUrl']) { throw 'Stale display/retry/context save destroyed update source' }
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $keyHash -or (Get-FileHash -LiteralPath $weixinFile -Algorithm SHA256).Hash -ne $weixinHash) { throw 'Update source save modified encrypted accounts' }
    # Deserialize<T>, not DeserializeObject: the real stdout callback decodes
    # JSON lists as ArrayList. Direct PowerShell object[] calls hid this bug.
    $otherWorkspace = Join-Path $scratch 'other project'
    [IO.Directory]::CreateDirectory($otherWorkspace) | Out-Null
    $workspaceSettings = New-Object 'Collections.Generic.Dictionary[string,object]'
    $workspaceSettings.Add('workspace', $otherWorkspace)
    $workspaceSettings.Add('recentWorkspaces', [object[]]@($otherWorkspace, $scratch))
    $workspaceSettings.Add('newWorkspaceDir', (Join-Path $scratch 'new projects'))
    $workspacePrefs = $serializer.DeserializeObject([IO.File]::ReadAllText($contextFile))['WorkspacePrefs']
    $workspacePrefs.Add($otherWorkspace, (New-Object 'Collections.Generic.Dictionary[string,object]'))
    $workspaceSettings.Add('workspacePrefs', $workspacePrefs)
    $workspaceFrame = New-Object 'Collections.Generic.Dictionary[string,object]'
    $workspaceFrame.Add('id', 'synthetic-workspace-save'); $workspaceFrame.Add('settings', $workspaceSettings)
    $workspaceWire = $serializer.Deserialize((ConvertTo-Json -InputObject $workspaceFrame -Depth 16 -Compress), [Collections.Generic.Dictionary[string,object]])
    if (!($workspaceWire['settings']['recentWorkspaces'] -is [Collections.ArrayList])) { throw 'Fixture does not match native JSON array decoding' }
    $windowType.GetMethod('PersistSettingsFrame', $flags).Invoke($window, [object[]]@($workspaceWire.PSObject.BaseObject)) | Out-Null
    $savedWorkspace = [IO.File]::ReadAllText($contextFile) | ConvertFrom-Json
    if ($savedWorkspace.Workspace -ne $otherWorkspace -or @($savedWorkspace.RecentWorkspaces).Count -ne 2 -or $savedWorkspace.RecentWorkspaces[0] -ne $otherWorkspace -or $savedWorkspace.RecentWorkspaces[1] -ne $scratch) { throw 'Actual JSON pipe lost recent workspace order' }
    $workspacePersist = $windowType.GetMethod('PersistWorkspaceSettingsFrame', $flags)
    if (!$workspacePersist) { throw 'Compiled workspace settings acknowledgement is missing' }
    function Invoke-WorkspacePersistence {
        $stream.SetLength(0); $stream.Position = 0
        $wire = $serializer.Deserialize((ConvertTo-Json -InputObject $workspaceFrame -Depth 16 -Compress), [Collections.Generic.Dictionary[string,object]])
        $workspacePersist.Invoke($window, [object[]]@($wire.PSObject.BaseObject)) | Out-Null
        $ack = [Text.Encoding]::UTF8.GetString($stream.ToArray()) | ConvertFrom-Json
        if ($ack.type -ne 'desktop/settings/saved' -or $ack.id -ne $workspaceFrame['id']) { throw 'Invalid workspace settings acknowledgement' }
        return $ack.ok
    }
    if (!(Invoke-WorkspacePersistence)) { throw 'Compiled workspace settings save was not acknowledged' }
    $workspaceText = [IO.File]::ReadAllText($contextFile)
    $windowType.GetMethod('LoadSettings', $flags).Invoke($window, [object[]]@()) | Out-Null
    if ($windowType.GetField('settings', $flags).GetValue($window).Workspace -ne $otherWorkspace -or $windowType.GetField('settings', $flags).GetValue($window).RecentWorkspaces.Length -ne 2) { throw 'Compiled workspace restart load failed' }
    $workspaceSettings['workspace'] = $scratch
    $workspaceSettings['recentWorkspaces'] = [object[]]@($scratch, $otherWorkspace)
    $heldWorkspace = New-Object IO.FileStream($contextFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if (Invoke-WorkspacePersistence) { throw 'Locked workspace settings were falsely acknowledged' }
        if ([IO.File]::ReadAllText($contextFile) -ne $workspaceText) { throw 'Failed workspace save changed disk settings' }
        if ($windowType.GetField('settings', $flags).GetValue($window).Workspace -ne $otherWorkspace) { throw 'Failed workspace save changed live native workspace' }
    } finally { $heldWorkspace.Dispose() }
    if (!(Invoke-WorkspacePersistence)) { throw 'Explicit workspace retry did not recover' }
    $workspaceText = [IO.File]::ReadAllText($contextFile)
    $workspaceSettings['recentWorkspaces'] = 'not-an-array'
    if (Invoke-WorkspacePersistence) { throw 'Malformed recent workspace list was acknowledged' }
    if ([IO.File]::ReadAllText($contextFile) -ne $workspaceText) { throw 'Malformed workspace list changed settings' }
    # Older no-id pages remain supported, and omitted recent lists keep the
    # existing value rather than clearing it to null.
    $workspaceFrame.Remove('id') | Out-Null; $workspaceSettings.Remove('recentWorkspaces') | Out-Null
    $stream.SetLength(0); $stream.Position = 0
    $legacyWire = $serializer.Deserialize((ConvertTo-Json -InputObject $workspaceFrame -Depth 16 -Compress), [Collections.Generic.Dictionary[string,object]])
    $workspacePersist.Invoke($window, [object[]]@($legacyWire.PSObject.BaseObject)) | Out-Null
    if ($stream.Length -ne 0) { throw 'Legacy workspace frame unexpectedly produced an acknowledgement' }
    $savedWorkspace = [IO.File]::ReadAllText($contextFile) | ConvertFrom-Json
    if ($savedWorkspace.RecentWorkspaces[0] -ne $scratch -or $savedWorkspace.RecentWorkspaces[1] -ne $otherWorkspace) { throw 'Legacy omitted recent list destroyed history' }
    if ($savedWorkspace.ProtectedApiKey -ne 'SYNTHETIC_LEGACY_CIPHERTEXT' -or $savedWorkspace.Appearance.quotaDisplay -ne 'hover' -or $savedWorkspace.Retry.maxRetries -ne 5 -or $savedWorkspace.Updates.feedUrl -ne $updates['feedUrl'] -or $savedWorkspace.WorkspacePrefs.PSObject.Properties[$scratch].Value.contextBudget.thresholdPercent -ne 70) { throw 'Workspace save destroyed unrelated preferences' }
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $keyHash -or (Get-FileHash -LiteralPath $weixinFile -Algorithm SHA256).Hash -ne $weixinHash) { throw 'Workspace save modified encrypted accounts' }
    Write-Output 'Compiled workspace real JSON arrays/order, disk acknowledgements, failure rollback, restart load and legacy merge PASS'
    Write-Output 'Compiled update source save/load/rollback, safe URLs and stale-frame preservation PASS'
    Write-Output 'Compiled retry policy save/load/rollback and credential/context/appearance preservation PASS'
    Write-Output 'Compiled appearance all modes/load/rollback and credential/context/stale-save preservation PASS'
    Write-Output 'Compiled context-budget settings save and failure acknowledgements PASS'
    Write-Output 'Compiled authorized-Key DPAPI save/load/logout and failure acknowledgements PASS (synthetic Key only)'
} finally {
    $writer.Dispose(); $stream.Dispose()
    Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}