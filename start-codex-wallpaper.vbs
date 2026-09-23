Option Explicit

Dim shell, fso, root, launcher, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
launcher = fso.BuildPath(root, "launch-wallpaper.ps1")
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File " & Quote(launcher) & " -LaunchIfNeeded"
shell.Run command, 0, False

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function
