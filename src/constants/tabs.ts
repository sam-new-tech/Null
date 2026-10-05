import type { ComponentType } from 'react';

import { CompassIcon, RepeatIcon, SparklesIcon, ClockIcon } from 'panelui-native/icons';

export interface TabMeta {
  name: string;
  href: '/' | '/bot' | '/trades' | '/history';
  label: string;
  Icon: ComponentType<{ size?: number; color?: string }>;
}

export const TABS: TabMeta[] = [
  { name: 'index', href: '/', label: 'Home', Icon: CompassIcon },
  { name: 'bot', href: '/bot', label: 'Bot', Icon: SparklesIcon },
  { name: 'trades', href: '/trades', label: 'Trades', Icon: RepeatIcon },
  { name: 'history', href: '/history', label: 'History', Icon: ClockIcon },
];

/** Space screens must leave at the bottom so the floating pill never covers content. */
export const TAB_CLEARANCE = 120;
