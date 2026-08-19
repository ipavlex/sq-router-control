/**
 * SQ Router Control — renderer entry point.
 * Importing the tab modules runs their top-level wiring (DOM bindings and
 * IPC subscriptions); this module then boots the connection screen.
 */
import "./types";
import "./dashboard";
import "./connect";
import { els, getRecent, renderRecent } from "./utils";

window.addEventListener("error", (e) => {
  // eslint-disable-next-line no-console
  console.error("RENDERER ERROR:", e.error ? e.error.stack : e.message);
});

renderRecent();
const recent = getRecent();
if (recent.length) {
  els.ip.value = recent[0];
}
els.ip.focus();
