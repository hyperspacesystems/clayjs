// A host that lists page-tool in this document's helper list can answer tool
// requests. Old clients look for a page-tool/1 entry in `extensions`, which no host
// adds, so they never show a dead /ai. The check stays in the core: the slash menu
// asks it before the tool view part loads.
export const capabilityAdvertised = (meta) =>
  Array.isArray(meta?.document?.helpers) &&
  meta.document.helpers.some((helper) =>
    helper?.name === "page-tool" && (helper.state === "ready" || helper.state === "unavailable"));
