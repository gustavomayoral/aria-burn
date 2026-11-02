; LightBurn 1.7.08
; GRBL device profile, absolute coords
G00 G17 G40 G21 G54
G90
M4
; Layer C02
; Cut @ 300 mm/min, 90% power
M8
G0 X20Y20
G1 X30S900F300
G1 Y30
G1 X20
G1 Y20
G1 S0
; Cut @ 300 mm/min, 90% power
G0 X20Y20
G1 X30S900F300
G1 Y30
G1 X20
G1 Y20
G1 S0
; Layer C03
; Cut @ 1200 mm/min, 30% power
G0 X40Y20
G1 X60S300F1200
G1 S0
M9
M5
G0 X0 Y0
M2
