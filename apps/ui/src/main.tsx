import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/nunito";
import "./styles.css";
import { Root } from "./app.tsx";
import { CrashBoundary } from "./crash.tsx";
import { startUpdates } from "./updates.tsx";
import { preloadRenderer } from "./rich.tsx";

createRoot(document.getElementById("root")!).render(<StrictMode><CrashBoundary><Root /></CrashBoundary></StrictMode>);
startUpdates();
preloadRenderer();
