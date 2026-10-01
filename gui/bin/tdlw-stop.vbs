' tdlw-stop - stop the background tdl Web GUI server.
' Kills only the node process serving our port, then any stray tdl.exe children,
' and clears the startup lock so the next launch is never blocked.
'
' NOTE: keep this file ASCII-only. wscript reads .vbs as ANSI, so non-ASCII
' text in a UTF-8 file breaks string parsing.
Option Explicit

Const PORT = 8560

Dim sh, fso, Q
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
Q = Chr(34)

' ---- locate the GUI dir (same rule as tdlw.vbs) to find the lock file ----
Dim scriptDir, pathFile, guiDir, ts
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
pathFile = fso.BuildPath(scriptDir, "tdlw.path")

guiDir = ""
If fso.FileExists(pathFile) Then
  Set ts = fso.OpenTextFile(pathFile, 1)
  guiDir = ts.ReadAll
  ts.Close
  guiDir = Replace(guiDir, vbCr, "")
  guiDir = Replace(guiDir, vbLf, "")
  guiDir = Trim(guiDir)
End If
If guiDir = "" Or Not fso.FileExists(fso.BuildPath(guiDir, "server.js")) Then
  guiDir = fso.GetParentFolderName(scriptDir)
End If

Dim killed
killed = False

' ---- kill the node process listening on our port -------------------------
Dim exec, out, lines, i, ln, parts, pid
Set exec = sh.Exec("%comspec% /c netstat -ano -p tcp")
out = exec.StdOut.ReadAll
lines = Split(out, vbCrLf)
For i = 0 To UBound(lines)
  ln = lines(i)
  If InStr(ln, ":" & PORT & " ") > 0 And InStr(ln, "LISTENING") > 0 Then
    ln = Trim(ln)
    Do While InStr(ln, "  ") > 0
      ln = Replace(ln, "  ", " ")
    Loop
    parts = Split(ln, " ")
    pid = parts(UBound(parts))
    If IsNumeric(pid) Then
      sh.Run "%comspec% /c taskkill /F /PID " & pid, 0, True
      killed = True
    End If
  End If
Next

' tdl.exe children hold the bolt database lock - release them too
sh.Run "%comspec% /c taskkill /F /IM tdl.exe", 0, True

' ---- clear a leftover startup lock --------------------------------------
Dim lockFile
lockFile = fso.BuildPath(guiDir, "data\tdlw.lock")
If fso.FileExists(lockFile) Then
  On Error Resume Next
  fso.DeleteFile lockFile, True
  Err.Clear
  On Error GoTo 0
End If

If killed Then
  MsgBox "tdl Web GUI stopped (port " & PORT & ").", 64, "tdlw"
Else
  MsgBox "No running tdl Web GUI found (port " & PORT & ").", 64, "tdlw"
End If
