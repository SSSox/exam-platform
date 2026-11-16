import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/nunito";
import "katex/dist/katex.min.css";
import "./styles.css";
import { Root } from "./app.tsx";
import { CrashBoundary } from "./crash.tsx";
import { startUpdates } from "./updates.tsx";

createRoot(document.getElementById("root")!).render(<StrictMode><CrashBoundary><Root /></CrashBoundary></StrictMode>);
startUpdates();
