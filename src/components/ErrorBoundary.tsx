import { Component, type ReactNode, type ErrorInfo } from 'react';
import { InfinityMark } from './icons';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Last-resort UI crash guard (L3): a render error anywhere below must not
 * leave the user staring at a blank page. Notes are safe — they live in the
 * encrypted IndexedDB, untouched by a React crash.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('UI crashed:', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="screen-center">
          <div className="card onboarding">
            <div className="logo-icon"><InfinityMark /></div>
            <h1>Что-то пошло не так</h1>
            <p className="subtitle">
              Интерфейс завершился с ошибкой. Заметки не пострадали — они в
              зашифрованном хранилище на устройстве.
            </p>
            <div className="error-msg" role="alert">{this.state.error.message}</div>
            <button className="btn btn-primary" onClick={() => window.location.reload()}>
              Перезагрузить
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
