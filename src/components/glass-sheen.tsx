import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet } from 'react-native';

/**
 * Glass specular sheen: bright top edge fading out downward,
 * like light catching a Liquid Glass surface. Pure overlay —
 * the AMOLED #000 base stays untouched underneath.
 */
export function GlassSheen({ radius = 16 }: { radius?: number }) {
  return (
    <LinearGradient
      colors={['rgba(255,255,255,0.05)', 'rgba(255,255,255,0.01)', 'rgba(255,255,255,0)']}
      locations={[0, 0.4, 0.75]}
      start={{ x: 0, y: 0 }}
      end={{ x: 0, y: 1 }}
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { borderRadius: radius }]}
    />
  );
}
