import { memo } from 'react';
import Svg, { Defs, Ellipse, Path, RadialGradient, Stop } from 'react-native-svg';

/**
 * Faint trading-chart line decoration + soft green goo glow
 * behind the screen, echoing the app's green-on-black brand.
 * Base stays AMOLED #000 — glows are low-opacity accents only.
 * Memoized: static art must not re-render on every live tick.
 */
export const ChartBackdrop = memo(function ChartBackdrop() {
  return (
    <Svg
      width="100%"
      height={460}
      viewBox="0 0 400 460"
      preserveAspectRatio="xMidYMin slice"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, opacity: 0.9, pointerEvents: 'none' }}>
      <Defs>
        <RadialGradient id="homeGooTop" cx="50%" cy="50%" r="50%">
          <Stop offset="0%" stopColor="#16a34a" stopOpacity={0.13} />
          <Stop offset="100%" stopColor="#16a34a" stopOpacity={0} />
        </RadialGradient>
        <RadialGradient id="homeGooMid" cx="50%" cy="50%" r="50%">
          <Stop offset="0%" stopColor="#4ade80" stopOpacity={0.07} />
          <Stop offset="100%" stopColor="#4ade80" stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Ellipse cx={60} cy={40} rx={170} ry={130} fill="url(#homeGooTop)" />
      <Ellipse cx={350} cy={260} rx={180} ry={150} fill="url(#homeGooMid)" />
      <Path
        d="M-10 330 C 60 320, 90 240, 150 235 S 250 150, 310 140 S 380 60, 430 55"
        fill="none"
        stroke="#16a34a"
        strokeOpacity={0.22}
        strokeWidth={2.5}
      />
      <Path
        d="M-10 360 C 70 350, 110 280, 170 275 S 260 190, 320 180 S 390 110, 430 105"
        fill="none"
        stroke="#16a34a"
        strokeOpacity={0.12}
        strokeWidth={2}
      />
      <Path
        d="M-10 300 C 50 295, 80 210, 140 205 S 240 120, 300 112 S 375 40, 430 35"
        fill="none"
        stroke="#4ade80"
        strokeOpacity={0.1}
        strokeWidth={1.5}
      />
    </Svg>
  );
}
