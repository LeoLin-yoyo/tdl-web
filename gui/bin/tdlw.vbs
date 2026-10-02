' tdlw - start the tdl Web GUI silently in the background and open the browser.
'
' Runs under wscript.exe, so no console window ever appears. The Node server is
' launched through a hidden cmd.exe that stays alive as its parent, which keeps
' stdout/stderr redirected into gui\data\server.log for troubleshooting.
'
' Idempotency (never start a second server):
'   1. Fast path - if the status endpoint already answers, just open the browser.
'   2. Startup lock - a lock file created with CREATE_NEW semantics is the
'      mutex, so two simultaneous launches cannot both start a server.
'   3. Stale lock recovery - if the lock is old and nothing answers, it is from
'      a crashed run and gets cleared; a fresh lock is respected and the second
'      launch backs off instead of racing.
'
' The GUI directory is read from tdlw.path (written next to this file by
' install-tdlw.bat). When run from the repo layout (gui\bin\tdlw.vbs) the path
' is derived from the script location instead.
'
' NOTE: keep this file ASCII-only. wscript reads .vbs as ANSI, so non-ASCII
' text in a UTF-8 file breaks string parsing.
Option Explicit

Const PORT = 8560
Const STATUS_URL = "http://127.0.0.1:8560/api/status"
Const STALE_LOCK_SECONDS = 90 ' older than this + no server = crashed run

Dim fso, sh, Q
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
Q = Chr(34) ' a single double-quote, keeps command assembly readable

' ---- locate the GUI directory -------------------------------------------
Dim scriptDir, guiDir, pathFile
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
pathFile = fso.BuildPath(scriptDir, "tdlw.path")

guiDir = ""
If fso.FileExists(pathFile) Then
  Dim ts
  Set ts = fso.OpenTextFile(pathFile, 1)
  ' VBScript Trim only strips spaces, so drop the CR/LF written by the installer
  guiDir = ts.ReadAll
  ts.Close
  guiDir = Replace(guiDir, vbCr, "")
  guiDir = Replace(guiDir, vbLf, "")
  guiDir = Trim(guiDir)
End If
If guiDir = "" Or Not fso.FileExists(fso.BuildPath(guiDir, "server.js")) Then
  guiDir = fso.GetParentFolderName(scriptDir) ' repo layout: gui\bin\tdlw.vbs
End If
If Not fso.FileExists(fso.BuildPath(guiDir, "server.js")) Then
  MsgBox "tdlw: server.js not found." & vbCrLf & vbCrLf & _
         "Run gui\bin\install-tdlw.bat first to install the launcher." & vbCrLf & _
         "Expected directory: " & guiDir, 16, "tdlw"
  WScript.Quit 1
End If

Dim dataDir, lockFile, logFile, serverJs
dataDir = fso.BuildPath(guiDir, "data")
If Not fso.FolderExists(dataDir) Then fso.CreateFolder(dataDir)
lockFile = fso.BuildPath(dataDir, "tdlw.lock")
logFile = fso.BuildPath(dataDir, "server.log")
serverJs = fso.BuildPath(guiDir, "server.js")

' ---- 1. fast path: a server is already answering -------------------------
If IsServerUp() Then
  OpenBrowser()
  WScript.Quit 0
End If

' ---- 2. acquire the startup lock (atomic create) -------------------------
Dim acquired
acquired = AcquireLock()

If Not acquired Then
  ' Someone else holds the lock. Decide what it means before waiting:
  '  - a stale lock (crashed run) is cleared immediately, no pointless wait
  '  - a fresh lock means another launch is mid-start: wait for its server
  If LockAgeSeconds() > STALE_LOCK_SECONDS And Not IsServerUp() Then
    ReleaseLock()
    acquired = AcquireLock()
  Else
    If WaitForServer(20) Then
      OpenBrowser()
      WScript.Quit 0
    End If
    ' still nothing after waiting: treat the lock as leftover and take over
    ReleaseLock()
    acquired = AcquireLock()
  End If
End If

If Not acquired Then
  sh.Popup "Another tdlw instance is starting up right now." & vbCrLf & _
           "Please wait a few seconds and try again." & vbCrLf & vbCrLf & _
           "If you are sure nothing is running, run tdlw-stop to clear it.", _
           8, "tdlw", 48
  WScript.Quit 1
End If

' From here on every failure path must release the lock.

' ---- dependencies must be installed once --------------------------------
If Not fso.FolderExists(fso.BuildPath(guiDir, "node_modules\node-pty")) Then
  ReleaseLock()
  MsgBox "tdlw: dependencies are not installed yet." & vbCrLf & vbCrLf & _
         "Please run this once:" & vbCrLf & guiDir & "\start.bat", 48, "tdlw"
  WScript.Quit 1
End If

' ---- find node.exe -------------------------------------------------------
Dim nodeExe
nodeExe = FindNode()
If nodeExe = "" Then
  ReleaseLock()
  MsgBox "tdlw: Node.js not found. Install Node.js 18+ first:" & vbCrLf & _
         "https://nodejs.org/", 16, "tdlw"
  WScript.Quit 1
End If

' ---- 3. start hidden, with logging --------------------------------------
Dim cmd
sh.CurrentDirectory = guiDir
cmd = "cmd /c " & Q & Q & nodeExe & Q & " " & Q & serverJs & Q & _
      " >> " & Q & logFile & Q & " 2>&1" & Q
' window style 0 = hidden; bWaitOnReturn False = do not block the launcher
sh.Run cmd, 0, False

' ---- wait for it to come up, then open the browser ----------------------
' The lock is only needed during the startup window: once the server answers,
' the fast path above is what keeps further launches from double-starting.
If WaitForServer(24) Then
  ReleaseLock()
  OpenBrowser()
  WScript.Quit 0
End If

' startup failed - free the lock so the next attempt is not blocked
ReleaseLock()

If PortInUse() Then
  MsgBox "tdlw: port " & PORT & " is already taken by another program." & vbCrLf & vbCrLf & _
         "Close it, or set a different port via the TDL_GUI_PORT environment variable.", _
         16, "tdlw"
Else
  MsgBox "tdlw: the server failed to start (timeout)." & vbCrLf & vbCrLf & _
         "Check the log:" & vbCrLf & logFile & vbCrLf & vbCrLf & _
         "Common causes: a bad proxy setting, or missing dependencies.", 16, "tdlw"
End If
WScript.Quit 1

' ---- helpers -------------------------------------------------------------

Sub OpenBrowser()
  sh.Run "http://127.0.0.1:" & PORT, 1, False
End Sub

' True when the GUI server answers on the status endpoint.
Function IsServerUp()
  Dim http
  On Error Resume Next
  IsServerUp = False
  Set http = CreateObject("MSXML2.XMLHTTP")
  http.Open "GET", STATUS_URL, False
  http.Send
  If Err.Number = 0 Then
    If http.Status = 200 Then IsServerUp = True
  End If
  Err.Clear
  On Error GoTo 0
End Function

' Poll the status endpoint for up to seconds*0.5s.
Function WaitForServer(seconds)
  Dim i
  WaitForServer = False
  For i = 1 To seconds * 2
    WScript.Sleep 500
    If IsServerUp() Then
      WaitForServer = True
      Exit Function
    End If
  Next
End Function

' True when something is listening on our port (not necessarily our server).
Function PortInUse()
  Dim exec, out
  PortInUse = False
  On Error Resume Next
  Set exec = sh.Exec("%comspec% /c netstat -ano -p tcp")
  out = exec.StdOut.ReadAll
  If Err.Number = 0 Then
    If InStr(out, ":" & PORT & " ") > 0 Then PortInUse = True
  End If
  Err.Clear
  On Error GoTo 0
End Function

' Atomic mutex: CreateTextFile with overwrite=False fails when the file exists.
Function AcquireLock()
  Dim f
  On Error Resume Next
  Set f = fso.CreateTextFile(lockFile, False)
  If Err.Number <> 0 Then
    Err.Clear
    AcquireLock = False
    Exit Function
  End If
  f.WriteLine "pid=launcher"
  f.WriteLine "started=" & Now
  f.Close
  AcquireLock = True
End Function

Sub ReleaseLock()
  On Error Resume Next
  If fso.FileExists(lockFile) Then fso.DeleteFile lockFile, True
  Err.Clear
  On Error GoTo 0
End Sub

' Age of the lock file in seconds; 0 when it does not exist.
Function LockAgeSeconds()
  Dim f
  On Error Resume Next
  LockAgeSeconds = 0
  If fso.FileExists(lockFile) Then
    Set f = fso.GetFile(lockFile)
    LockAgeSeconds = DateDiff("s", f.DateLastModified, Now)
  End If
  Err.Clear
  On Error GoTo 0
End Function

' Absolute path to node.exe: known install locations first, PATH as fallback.
Function FindNode()
  Dim candidates, p, pf, pf86, lad, ad
  pf = sh.ExpandEnvironmentStrings("%ProgramFiles%")
  pf86 = sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%")
  lad = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%")
  ad = sh.ExpandEnvironmentStrings("%APPDATA%")
  candidates = Array( _
    "D:\Program Files\nodejs\node.exe", _
    "C:\Program Files\nodejs\node.exe", _
    pf & "\nodejs\node.exe", _
    pf86 & "\nodejs\node.exe", _
    lad & "\Programs\nodejs\node.exe", _
    ad & "\npm\node.exe" _
  )
  FindNode = ""
  For Each p In candidates
    If p <> "" Then
      If fso.FileExists(p) Then
        FindNode = p
        Exit Function
      End If
    End If
  Next
  ' fall back to a bare name; the hidden cmd resolves it via PATH
  FindNode = "node"
End Function
