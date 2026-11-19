# Hydraulic Calculation Formulas

## 1. Hazen-Williams Friction Loss Equation (Metric)

$$\Delta P = 6.05 \times 10^5 \times \frac{Q^{1.85}}{C^{1.85} \times d_i^{4.87}} \times L$$

- $\Delta P$: Friction loss (bar)
- $Q$: Flow rate (L/min)
- $C$: Roughness coefficient ($C = 120$ for steel pipe, $C = 150$ for CPVC)
- $d_i$: Actual internal diameter (mm)
- $L$: Equivalent length (m), including pipe length and fitting equivalent lengths

## 2. Sprinkler Discharge Formula

$$Q = K \times \sqrt{P}$$

- $Q$: Discharge flow rate (L/min)
- $K$: Metric K-factor (standard K = 80 L/min·bar$^{0.5}$)
- $P$: Operating pressure at deflector (bar)

## 3. Static Elevation Head Change

$$\Delta P_{\text{elev}} = 0.0981 \times \Delta h$$

- $\Delta P_{\text{elev}}$: Pressure change (bar)
- $\Delta h$: Elevation change in meters (positive = upward flow, loss; negative = downward flow, gain)
```
