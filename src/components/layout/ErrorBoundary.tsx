import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center h-screen bg-zinc-950 text-zinc-300">
          <div className="text-center space-y-4">
            <h1 className="text-xl font-semibold">出错了</h1>
            <p className="text-sm text-zinc-500">应用遇到意外错误，请尝试重新加载</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-md bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-500 transition-colors"
            >
              重新加载
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
