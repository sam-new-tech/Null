import { forwardRef } from 'react';
import type { ComponentProps } from 'react';
import type { Text as RNTextType } from 'react-native';

import { Text as BaseText } from 'panelui-native/primitives/text';

type BaseTextProps = ComponentProps<typeof BaseText>;

export interface TextProps extends BaseTextProps {
  /**
   * Shrink the line to fit its container instead of overflowing. Use it for
   * money and price figures whose width changes with the value.
   */
  fit?: boolean;
}

/**
 * How far the OS text-size setting may push each step. Captions can grow a
 * little; display figures stay near their design size so a phone set to the
 * largest font cannot push a balance across the whole row.
 */
const MAX_SCALE: Record<string, number> = {
  xs: 1.4,
  sm: 1.35,
  base: 1.3,
  lg: 1.3,
  xl: 1.2,
  '2xl': 1.15,
  '3xl': 1.1,
};

/**
 * App-wide text primitive. Wraps the design-system `Text` with a size-aware
 * font-scale cap and an opt-in `fit` mode for numeric displays, so every
 * screen stays readable on small phones and with accessibility text sizes.
 */
export const Text = forwardRef<RNTextType, TextProps>(function Text(
  { size, maxFontSizeMultiplier, fit = false, numberOfLines, minimumFontScale, ...props },
  ref
) {
  const cap = (size && MAX_SCALE[size]) || MAX_SCALE.base;

  return (
    <BaseText
      ref={ref}
      size={size}
      maxFontSizeMultiplier={maxFontSizeMultiplier ?? cap}
      numberOfLines={fit && numberOfLines === undefined ? 1 : numberOfLines}
      adjustsFontSizeToFit={fit || undefined}
      minimumFontScale={fit ? (minimumFontScale ?? 0.55) : minimumFontScale}
      {...props}
    />
  );
});

Text.displayName = 'Text';
