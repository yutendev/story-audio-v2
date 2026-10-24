// Entry DOM của index.html — mount App vào #root.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root không tồn tại");
createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
