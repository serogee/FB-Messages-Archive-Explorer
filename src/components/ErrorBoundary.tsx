import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] Caught error:', error, info.componentStack);
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
  };

  handleFullReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary">
          <div className="error-boundary-card">
            <div className="error-boundary-icon">⚠️</div>
            <h2>Something went wrong</h2>
            <p className="error-boundary-message">
              {this.state.error?.message || 'An unexpected error occurred.'}
            </p>
            <div className="error-boundary-actions">
              <button
                className="error-boundary-btn error-boundary-btn-primary"
                onClick={this.handleReload}
              >
                Try Again
              </button>
              <button
                className="error-boundary-btn error-boundary-btn-secondary"
                onClick={this.handleFullReload}
              >
                Reload Page
              </button>
            </div>
            <details className="error-boundary-details">
              <summary>Technical Details</summary>
              <pre>{this.state.error?.stack || 'No stack trace available'}</pre>
            </details>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
