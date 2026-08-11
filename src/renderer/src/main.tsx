import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import "highlight.js/styles/github.css";
import { remoteWebRtcTransport } from "./remote/transport";

void remoteWebRtcTransport.start();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
