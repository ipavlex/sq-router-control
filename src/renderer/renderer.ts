/**
 * SQ Router Control — renderer entry point.
 * Importing the tab modules runs their top-level wiring (DOM bindings and
 * IPC subscriptions); this module then boots the connection screen.
 */
import "./core/types";
import "./dashboard";
import "./connect";
import { elementRefs, getRecent, renderRecent } from "./core/utils";

window.addEventListener("error", (e) => {
  // eslint-disable-next-line no-console
  console.error("RENDERER ERROR:", e.error ? e.error.stack : e.message);
});

renderRecent();
const recent = getRecent();
if (recent.length) {
  elementRefs.ip.value = recent[0];
}
elementRefs.ip.focus();
