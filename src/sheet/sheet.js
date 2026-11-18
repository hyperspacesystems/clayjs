import { startShell } from "./shell.js";

// The sheet editor (`?plugins=sheet`, edit mode). C5a: the row window. The owned region,
// the chrome and editing land in C5b to C8, the optional features and their loader in C11.
const shell = startShell();

export const sheet = {
  windows: shell.windows,
};

export const ready = Promise.resolve();
export default sheet;
