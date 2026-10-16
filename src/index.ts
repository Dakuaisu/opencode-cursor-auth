// opencode calls EVERY named export of a plugin module as a plugin, so this
// entry must expose exactly one export; helpers live in plugin.ts.
export { CursorAuthPlugin as default } from "./plugin.js"
