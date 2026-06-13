import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// Token cascade — order matters: tokens.css declares the CSS custom
// properties that glass.css and motion.css reference.
import "./styles/tokens.css";
import "./styles/glass.css";
import "./styles/motion.css";
import "./styles/toast.css";
import "./styles/panels.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
