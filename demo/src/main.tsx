import { createRoot } from "react-dom/client";

import { App } from "./App";
import { EnginePresentationDemo } from "./engine/EnginePresentationDemo";
import { isEnginePresentationRequested } from "./engine/engine-presentation-mode";
import "./styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Demo root element not found.");
}

createRoot(rootElement).render(
  isEnginePresentationRequested(window.location.search) ? (
    <EnginePresentationDemo />
  ) : (
    <App />
  ),
);
