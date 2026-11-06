; The stock NSIS stub has no DPI-awareness declaration. Prevent Windows from
; enlarging the whole wizard as a low-resolution bitmap on high-DPI displays.
; The 3x RGB artwork uses MUI's default FitControl behavior at the native size.
!macro customHeader
  ManifestDPIAware true
!macroend
