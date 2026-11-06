' Start the Sai agent with no window.
'
' Node has no windowless build, so a console window appears however it is launched -
' and a window a shopkeeper can close is a window that gets closed, which stops the
' shop syncing with nothing on screen to say so. wscript.exe can launch a process with
' its window hidden, which is the dependency-free way to do this on Windows.
'
' Hidden must not mean blind: output is appended to agent.log, and the agent keeps
' reporting its own liveness to the cloud every 30 seconds, so the dashboard and
' `npm run check` both show whether this PC is healthy.
'
' Nothing here may block. This runs at sign-in, so a dialog waiting to be clicked
' would stall startup with no window visible to click. Everything is written to the
' log instead.

Option Explicit

Dim fso, shell, stateDir, logFile, agentPath, cmd

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

stateDir = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\SaiAgent"
agentPath = stateDir & "\sai-agent.js"
logFile = stateDir & "\agent.log"

If Not fso.FolderExists(stateDir) Then
  On Error Resume Next
  fso.CreateFolder stateDir
  On Error Goto 0
End If

Sub Note(message)
  On Error Resume Next
  Dim out
  Set out = fso.OpenTextFile(logFile, 8, True)   ' 8 = append, True = create if absent
  out.WriteLine Now & "  " & message
  out.Close
  On Error Goto 0
End Sub

If Not fso.FileExists(agentPath) Then
  Note "cannot start: no agent at " & agentPath & " - run the installer again"
  WScript.Quit 1
End If

' Keep the log bounded. A shop PC runs this every day for years.
On Error Resume Next
If fso.FileExists(logFile) Then
  If fso.GetFile(logFile).Size > 4194304 Then   ' 4 MB
    fso.DeleteFile logFile, True
  End If
End If
On Error Goto 0

Note "starting the agent in the background"

' cmd /c so stdout and stderr land in the log. node is resolved through PATH by cmd,
' which the installer has already confirmed works - probing for it here risked blocking
' on a pipe read at sign-in, for no benefit.
'
' 0 hides the window. False means do not wait: this launcher exits straight away and
' the agent carries on running.
cmd = "cmd /c node """ & agentPath & """ >> """ & logFile & """ 2>&1"
shell.Run cmd, 0, False
