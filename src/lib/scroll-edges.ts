/**
 * An attachment for a scrolling element: marks its parent with
 * data-more-above / data-more-below while content lies above or below what
 * is in view, for a fade at that edge. Read again on scroll and whenever the
 * element or any of its children changes size.
 */
export function markHidden(body: HTMLElement) {
  const update = () => {
    const wrap = body.parentElement;
    wrap?.toggleAttribute("data-more-above", body.scrollTop > 1);
    wrap?.toggleAttribute(
      "data-more-below",
      body.scrollHeight - body.scrollTop - body.clientHeight > 1,
    );
  };
  const sizes = new ResizeObserver(update);
  const watch = () => {
    sizes.disconnect();
    sizes.observe(body);
    for (const child of body.children) sizes.observe(child);
    update();
  };
  const content = new MutationObserver(watch);
  content.observe(body, { childList: true });
  body.addEventListener("scroll", update, { passive: true });
  watch();
  return () => {
    sizes.disconnect();
    content.disconnect();
    body.removeEventListener("scroll", update);
  };
}
