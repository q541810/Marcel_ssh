import { Component, type ReactNode } from 'react';
import ErrorScreen from './ErrorScreen';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  /** 触发兜底的错误本体：错误屏上必须展示它，否则用户只能看到「出错了」三个字，
   *  报 bug 时拿不到任何线索（console 里的错误对象复制文本时会丢）。 */
  error: unknown;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return <ErrorScreen error={this.state.error} />;
    }

    return this.props.children;
  }
}
