import { createRoot } from "react-dom/client";

import { App } from "./App";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Demo root element not found.");
}

createRoot(rootElement).render(<App />);
