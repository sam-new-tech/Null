import { useWindowDimensions } from 'react-native';

export interface Responsive {
  width: number;
  height: number;
  /** Very narrow phones (e.g. 320 dp) — drop large artwork and type a step. */
  isNarrow: boolean;
  /** Common small phones (< 375 dp) — tighten artwork and display type. */
  isCompact: boolean;
  /** Tablets and foldables — room for the full-size presentation. */
  isLarge: boolean;
  /**
   * Multiplier for artwork and hero elements, clamped so a 320 dp phone does
   * not shrink them into nothing and a tablet does not blow them up.
   */
  displayScale: number;
}

/**
 * One shared read of the window size so screens can adapt layout instead of
 * assuming a single phone width. Values are derived from `useWindowDimensions`
 * and update on rotation and split-screen changes.
 */
export function useResponsive(): Responsive {
  const { width, height } = useWindowDimensions();
  const isNarrow = width < 360;
  const isCompact = width < 390;
  const isLarge = width >= 600;

  const displayScale = isLarge ? 1.15 : isNarrow ? 0.78 : isCompact ? 0.9 : 1;

  return { width, height, isNarrow, isCompact, isLarge, displayScale };
}
