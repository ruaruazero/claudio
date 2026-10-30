import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { DesignPreview } from "./ui/DesignPreview";
import "./ui/radio.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {new URLSearchParams(location.search).get("preview") === "design" ? <DesignPreview /> : <App />}
  </React.StrictMode>,
);
