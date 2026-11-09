param(
  [Parameter(Mandatory)][string]$CodePath,
  [Parameter(Mandatory)][string]$ExtensionPath,
  [Parameter(Mandatory)][string]$TestsPath,
  [Parameter(Mandatory)][string]$UserData,
  [Parameter(Mandatory)][string]$ExtensionsDir,
  [Parameter(Mandatory)][string]$Workspace,
  [Parameter(Mandatory)][string]$ResultFile
)
$ErrorActionPreference = 'Stop'

# The process runs on a separate desktop that is never made visible. A job
# contains only the new process tree and is terminated on timeout or exit.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class CorePilotHiddenHost {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb; public string lpReserved, lpDesktop, lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION {
    public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId;
  }
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr devmode, int flags, uint access, IntPtr attributes);
  [DllImport("user32.dll", SetLastError = true)] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcess(string app, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
    bool inheritHandles, uint flags, IntPtr environment, string currentDirectory, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);

  public static uint Run(string code, string arguments, string desktopName, string cwd) {
    IntPtr desktop = CreateDesktop(desktopName, IntPtr.Zero, IntPtr.Zero, 0, 0x000F01FF, IntPtr.Zero);
    if (desktop == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot create isolated desktop");
    IntPtr job = IntPtr.Zero; PROCESS_INFORMATION process = new PROCESS_INFORMATION();
    try {
      job = CreateJobObject(IntPtr.Zero, null);
      if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot create isolated job");
      var startup = new STARTUPINFO { cb = Marshal.SizeOf(typeof(STARTUPINFO)), lpDesktop = "WinSta0\\" + desktopName, dwFlags = 1, wShowWindow = 0 };
      // Suspend until the new process has been assigned to the isolated job.
      if (!CreateProcess(code, new StringBuilder(arguments), IntPtr.Zero, IntPtr.Zero, false, 0x08000004, IntPtr.Zero, cwd, ref startup, out process))
        throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot start isolated Extension Host");
      if (!AssignProcessToJobObject(job, process.hProcess)) {
        int error = Marshal.GetLastWin32Error(); TerminateProcess(process.hProcess, 1);
        throw new Win32Exception(error, "Cannot isolate Extension Host process tree");
      }
      if (ResumeThread(process.hThread) == 0xFFFFFFFF) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot resume isolated Extension Host");
      if (WaitForSingleObject(process.hProcess, 60000) != 0) throw new TimeoutException("Isolated Extension Host did not exit in 60 seconds");
      uint exitCode;
      if (!GetExitCodeProcess(process.hProcess, out exitCode)) throw new Win32Exception(Marshal.GetLastWin32Error());
      return exitCode;
    } finally {
      if (job != IntPtr.Zero) { TerminateJobObject(job, 1); CloseHandle(job); }
      if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
      if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
      CloseDesktop(desktop);
    }
  }
}
'@

$env:COREPILOT_EXTENSION_TEST_RESULT = $ResultFile
$arguments = @($CodePath, $Workspace, "--user-data-dir=$UserData", "--extensions-dir=$ExtensionsDir", '--new-window',
  '--disable-updates', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
  "--extensionDevelopmentPath=$ExtensionPath", "--extensionTestsPath=$TestsPath")
$commandLine = ($arguments | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }) -join ' '
$desktopName = 'CorePilotExtensionTest-' + [guid]::NewGuid().ToString('N')
$exitCode = [CorePilotHiddenHost]::Run($CodePath, $commandLine, $desktopName, $Workspace)
if ($exitCode -ne 0) { throw "Isolated Extension Host exited with code $exitCode" }
