import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./capsule-player.css";
import "./now-playing.css";
import "./shell.css";
import "./artists.css";
import "./home.css";
import "./catalog.css";
import "./login.css";
import "./states.css";
import "./accounts.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App /></React.StrictMode>
);
