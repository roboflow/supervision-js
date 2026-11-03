import { createRoot } from "react-dom/client";

import { PlayerApp } from "./PlayerApp";
import "../styles.css";
import "./player.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Player root element not found.");
}

createRoot(rootElement).render(<PlayerApp />);
