' tblw - alias for tdlw (same silent launch, same script).
' Kept as a thin forwarder so both spellings work; tdlw.vbs holds the logic.
'
' NOTE: keep this file ASCII-only. wscript reads .vbs as ANSI, so non-ASCII
' text in a UTF-8 file breaks string parsing.
Option Explicit

Dim sh, fso, here, target
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
target = fso.BuildPath(here, "tdlw.vbs")

If fso.FileExists(target) Then
  ' explicit wscript.exe (never cscript, which would flash a console window)
  sh.Run "wscript.exe " & Chr(34) & target & Chr(34), 0, False
Else
  MsgBox "tblw: tdlw.vbs not found next to this script:" & vbCrLf & here, 16, "tblw"
  WScript.Quit 1
End If
