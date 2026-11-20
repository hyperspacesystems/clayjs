const RULES = 'script[data-rules-name~="api"]';

// "New blank document": this page with its data emptied, as a new file the host keeps or
// the browser downloads. Only a page with an api rules tag knows what its data is. Nothing
// is asked of the host until the item is clicked.
export function addNewDocumentItem({ addItem, note }) {
  if (!document.querySelector(RULES)) return;
  addItem({
    id: "clay.new",
    label: "New blank document",
    run: async () => {
      let result = null;
      try {
        result = await window.clay.newDocument.create();
      } catch {}
      if (result?.ok && typeof result.href === "string") {
        // Opened after the host answers, so a popup blocker may refuse it; then this tab goes.
        // "noopener" would make window.open answer null even when it opened, so opener is cut here.
        const opened = window.open(result.href, "_blank");
        if (opened) opened.opener = null;
        else window.location.assign(result.href);
      } else if (!result?.ok) note(result?.message || "Couldn't make a new document. Try again.");
    },
  });
}
