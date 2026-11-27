import React, { lazy } from "react";
import ReactDOM from "react-dom/client";
import { HelmetProvider } from "react-helmet-async";
import { createBrowserRouter, RouterProvider, Navigate } from "react-router-dom";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles/index.css";
const Layout = lazy(() => import("./game/Layout"));
const Game = lazy(() => import("./game/Game"));
const Portfolio = lazy(() => import("./game/PortfolioLayout"));
const Rounds = lazy(() => import("./game/Rounds"));
const Assets = lazy(() => import("./pages/portfolio/Assets"));
const History = lazy(() => import("./pages/portfolio/History"));
const router = createBrowserRouter([{ path: "/", element: <App/>, errorElement: <ErrorBoundary/>, children: [{ element: <Layout/>, children: [
  { index: true, element: <Game/> },
  { path: "portfolio", element: <Portfolio/>, children: [
    { index: true, element: <Rounds/> }, { path: "rounds", element: <Navigate to="/portfolio" replace/> },
    { path: "assets", element: <Assets/> }, { path: "history", element: <History/> },
    { path: "positions", element: <Navigate to="/portfolio" replace/> },
  ] },
  { path: "*", element: <Navigate to="/" replace/> },
] }] }], { basename: (import.meta.env.BASE_URL || "/").replace(/\/$/, "") || "/" });
ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><HelmetProvider><RouterProvider router={router}/></HelmetProvider></React.StrictMode>);
