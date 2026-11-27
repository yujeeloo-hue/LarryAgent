; The stock NSIS stub has no DPI-awareness declaration. Prevent Windows from
; enlarging the whole wizard as a low-resolution bitmap on high-DPI displays.
; The 3x RGB artwork uses MUI's default FitControl behavior at the native size.
!macro customHeader
  ManifestDPIAware true
!macroend

!macro customInstall
  ${ifNot} ${Silent}
  ${andIfNot} ${isUpdated}
    IfFileExists "$PROGRAMFILES64\LLVM\bin\clangd.exe" clangdPresent
    SearchPath $0 "clangd.exe"
    StrCmp $0 "" 0 clangdPresent
    MessageBox MB_YESNO|MB_ICONQUESTION "C++ code completion and navigation in Dev Mode use clangd from LLVM, which is not installed.$\r$\n$\r$\nInstall the latest LLVM now? This opens a console window that runs winget and may ask for administrator permission." /SD IDNO IDNO clangdPresent
    ExecShell "open" "$SYSDIR\cmd.exe" '/c winget install --id LLVM.LLVM --exact --source winget --accept-source-agreements --accept-package-agreements || pause'
    clangdPresent:
  ${endIf}
!macroend
