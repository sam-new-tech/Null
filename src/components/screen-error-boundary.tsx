import { Component, type ReactNode } from 'react';
import { View } from 'react-native';

import { Button } from 'panelui-native/components/button';
import { Card } from 'panelui-native/components/card';
import { GlassSheen } from '@/components/glass-sheen';
import { Text } from 'panelui-native/primitives/text';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Production error boundary for tab screens. A render crash in one widget
 * (e.g. malformed broker payload) shows a retry card instead of blanking
 * the whole tab.
 */
export class ScreenErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.warn('[ui] screen crashed:', error.message);
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <View className="flex-1 items-center justify-center bg-background p-6">
          <Card className="w-full">
            <GlassSheen />
            <Card.Content className="items-center gap-3 p-6">
              <Text size="lg" weight="bold" className="text-center">
                Something went wrong
              </Text>
              <Text size="sm" muted className="text-center">
                {this.state.error.message}
              </Text>
              <Button variant="outline" onPress={this.reset}>
                Try again
              </Button>
            </Card.Content>
          </Card>
        </View>
      );
    }
    return this.props.children;
  }
}
