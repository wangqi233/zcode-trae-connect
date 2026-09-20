' Launch trae2api in the background with no console window.
' Runs start-gateway.bat from this script's own directory, so the project can
' live anywhere. Useful for a Windows scheduled task that starts it at logon.
Dim fso, here
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run """" & here & "\start-gateway.bat""", 0, False
