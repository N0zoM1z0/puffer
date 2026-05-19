type ModalFocusOptions = {
  onClose?: () => void;
  closeDisabled?: boolean;
};

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

function isFocusable(element: HTMLElement): boolean {
  if (element.hasAttribute("disabled")) return false;
  if (element.getAttribute("aria-hidden") === "true") return false;
  if (element.tabIndex < 0) return false;
  return element.getClientRects().length > 0;
}

function focusableElements(node: HTMLElement): HTMLElement[] {
  return Array.from(node.querySelectorAll<HTMLElement>(focusableSelector)).filter(isFocusable);
}

function focusInitial(node: HTMLElement): void {
  const initial = node.querySelector<HTMLElement>("[data-modal-initial-focus]");
  if (initial && isFocusable(initial)) {
    initial.focus();
    return;
  }
  const first = focusableElements(node)[0] ?? node;
  first.focus();
}

/** Traps keyboard focus within a modal dialog and restores the opener on close. */
export function trapModalFocus(node: HTMLElement, options: ModalFocusOptions = {}) {
  let currentOptions = options;
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  queueMicrotask(() => {
    focusInitial(node);
  });

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      if (!currentOptions.closeDisabled) {
        event.preventDefault();
        event.stopPropagation();
        currentOptions.onClose?.();
      }
      return;
    }

    if (event.key !== "Tab") return;

    const elements = focusableElements(node);
    if (elements.length === 0) {
      event.preventDefault();
      node.focus();
      return;
    }

    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const activeIndex = active ? elements.indexOf(active) : -1;
    const nextIndex = event.shiftKey
      ? activeIndex <= 0 ? elements.length - 1 : activeIndex - 1
      : activeIndex === -1 || activeIndex === elements.length - 1 ? 0 : activeIndex + 1;

    event.preventDefault();
    elements[nextIndex].focus();
  }

  function handleFocusIn(event: FocusEvent): void {
    if (event.target instanceof Node && node.contains(event.target)) return;
    focusInitial(node);
  }

  node.addEventListener("keydown", handleKeydown);
  document.addEventListener("focusin", handleFocusIn);

  return {
    update(nextOptions: ModalFocusOptions = {}) {
      currentOptions = nextOptions;
    },
    destroy() {
      node.removeEventListener("keydown", handleKeydown);
      document.removeEventListener("focusin", handleFocusIn);
      if (opener?.isConnected) {
        queueMicrotask(() => opener.focus());
      }
    }
  };
}
