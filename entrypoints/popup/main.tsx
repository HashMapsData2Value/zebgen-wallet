import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import ExternalRequestApp from './ExternalRequestApp.tsx';
import './style.css';

const zebgenRequestId = new URLSearchParams(window.location.search).get('zebgenRequestId');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {zebgenRequestId ? <ExternalRequestApp requestId={zebgenRequestId} /> : <App />}
  </React.StrictMode>,
);
