; Show the install log/details listbox expanded on the installing page.
; ShowInstDetails is only valid at script (page) scope — NOT inside a
; Function, and customInit expands inside .onInit (makensis: "command
; ShowInstDetails not valid in Function"). customHeader expands at global
; scope after common.nsh, so it also overrides its `ShowInstDetails nevershow`.
!macro customHeader
  ShowInstDetails show
!macroend
