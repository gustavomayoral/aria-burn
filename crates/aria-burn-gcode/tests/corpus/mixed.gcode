; mixed raster + vector with R-form and I/J arcs, G92 work offset
G21
G90
G0 X100 Y100
G92 X0 Y0
M4 S1000 F800
G1 X10
G2 X20 Y0 R5
G3 X10 Y0 I-5 J0
G1 Y-5
S0
; raster patch
G0 X0 Y10
M3
G1 X5 S500 F2000
G1 Y10.1 S0
G1 X0 S500
M5
G92.1
G0 X0 Y0
M30
