; LightBurn 1.7.08
; GRBL device profile, absolute coords
; Bounds: X5 Y5 to X45 Y35
G00 G17 G40 G21 G54
G90
M4
; Layer C00
; Cut @ 600 mm/min, 60% power
M8
G0 X5Y5
G1 X45S600F600
G1 Y35
G1 X5
G1 Y5
G1 S0
G0 X25Y20
G2 X25Y20I5J0S600
G1 S0
M9
G1 S0
M5
G90
; return to user-defined finish pos
G0 X0 Y0
M2
