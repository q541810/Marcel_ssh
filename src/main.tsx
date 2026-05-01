import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/globals.css';

function AppWrapper() {
  useEffect(() => {
    // Hide loading screen once React has mounted
    document.body.classList.add('loaded');
  }, []);

  return <App />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppWrapper />
  </React.StrictMode>,
);
