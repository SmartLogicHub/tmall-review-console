$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

public static class NativeCredentialApi
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL
    {
        public UInt32 Flags;
        public UInt32 Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public UInt32 CredentialBlobSize;
        public IntPtr CredentialBlob;
        public UInt32 Persist;
        public UInt32 AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("Advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);

    [DllImport("Advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);

    [DllImport("Advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);

    [DllImport("Advapi32.dll", EntryPoint = "CredFree")]
    public static extern void CredFree(IntPtr buffer);
}
"@

$CredentialTypeGeneric = 1
$CredentialPersistLocalMachine = 2
$ErrorNotFound = 1168

function Read-CredentialValue([string]$Target) {
    $pointer = [IntPtr]::Zero
    if (-not [NativeCredentialApi]::CredRead($Target, $CredentialTypeGeneric, 0, [ref]$pointer)) {
        $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($errorCode -eq $ErrorNotFound) { return $null }
        throw "CredReadW failed with Windows error $errorCode"
    }
    try {
        $credential = [Runtime.InteropServices.Marshal]::PtrToStructure(
            $pointer,
            [type][NativeCredentialApi+CREDENTIAL]
        )
        if ($credential.CredentialBlobSize -eq 0) { return "" }
        $bytes = New-Object byte[] $credential.CredentialBlobSize
        [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $bytes.Length)
        return [Text.Encoding]::Unicode.GetString($bytes)
    }
    finally {
        [NativeCredentialApi]::CredFree($pointer)
    }
}

function Write-CredentialValue([string]$Target, [string]$Secret) {
    $bytes = [Text.Encoding]::Unicode.GetBytes($Secret)
    $blob = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
    try {
        [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
        $credential = New-Object NativeCredentialApi+CREDENTIAL
        $credential.Type = $CredentialTypeGeneric
        $credential.TargetName = $Target
        $credential.CredentialBlobSize = $bytes.Length
        $credential.CredentialBlob = $blob
        $credential.Persist = $CredentialPersistLocalMachine
        $credential.UserName = "Tmall Review Console"
        if (-not [NativeCredentialApi]::CredWrite([ref]$credential, 0)) {
            $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
            throw "CredWriteW failed with Windows error $errorCode"
        }
    }
    finally {
        for ($index = 0; $index -lt $bytes.Length; $index++) {
            [Runtime.InteropServices.Marshal]::WriteByte($blob, $index, 0)
        }
        [Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
    }
}

function Remove-CredentialValue([string]$Target) {
    if (-not [NativeCredentialApi]::CredDelete($Target, $CredentialTypeGeneric, 0)) {
        $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($errorCode -ne $ErrorNotFound) {
            throw "CredDeleteW failed with Windows error $errorCode"
        }
    }
}

try {
    $requestText = [Console]::In.ReadToEnd()
    $request = $requestText | ConvertFrom-Json
    switch ($request.action) {
        "write" {
            Write-CredentialValue -Target $request.target -Secret $request.secret
            @{ ok = $true } | ConvertTo-Json -Compress
        }
        "read" {
            $value = Read-CredentialValue -Target $request.target
            @{ ok = $true; value = $value } | ConvertTo-Json -Compress
        }
        "has" {
            $value = Read-CredentialValue -Target $request.target
            @{ ok = $true; exists = ($null -ne $value) } | ConvertTo-Json -Compress
        }
        "delete" {
            Remove-CredentialValue -Target $request.target
            @{ ok = $true } | ConvertTo-Json -Compress
        }
        default { throw "Unsupported credential action" }
    }
}
catch {
    @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}
