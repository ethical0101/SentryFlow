import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { SentryProvider } from "./state";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SentryProvider>
      <App />
    </SentryProvider>
  </StrictMode>,
);
