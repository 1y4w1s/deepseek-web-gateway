Option Explicit
Dim fso, shell, root, desktop, link, command
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
desktop = shell.SpecialFolders("Desktop")

If Not fso.FileExists(desktop & "\DeepSeek Web API.lnk") Then
    Set link = shell.CreateShortcut(desktop & "\DeepSeek Web API.lnk")
    link.TargetPath = WScript.FullName
    link.Arguments = """" & WScript.ScriptFullName & """"
    link.WorkingDirectory = root
    link.Description = "Start the local DeepSeek Web API"
    link.Save
End If

command = "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & root & "\Start.ps1"""
shell.Run command, 0, False
